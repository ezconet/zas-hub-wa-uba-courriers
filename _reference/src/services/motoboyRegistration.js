const crmClient = require('../api/crmClient');
const waClient = require('../whatsapp/client');
const db = require('../db/database');
const { extractNameAndPix, interpretConfirmation, interpretKeyResponse } = require('./aiExtractor');

function foneFromJid(jid) {
  return jid.split('@')[0].replace(/\D/g, '');
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function now() {
  return new Date().toISOString();
}

/**
 * Disparado após o motoboy aceitar o pedido.
 * - Se já confirmou hoje → atribui direto, sem mensagens
 * - Se cadastrado no CRM → pede confirmação da chave
 * - Se novo → pede nome e PIX livremente
 */
async function startRegistration(idPedido, motoboyJid) {
  const fone = foneFromJid(motoboyJid);
  console.log(`[REG] Buscando motoboy pelo fone: ${fone}`);

  let motoboy = null;
  try {
    motoboy = await crmClient.fetchMotoboy(fone);
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      console.log(`[REG] Motoboy ${fone} não cadastrado. Pedido ${idPedido} sem atribuição.`);
    } else {
      console.error(`[REG] Erro ao buscar motoboy (${fone}): status=${status} msg=${err.message}`);
    }
    return;
  }

  if (!motoboy) {
    console.log(`[REG] Motoboy ${fone} não encontrado. Pedido ${idPedido} sem atribuição.`);
    return;
  }

  const nome = motoboy.nome || motoboy.Nome || '';
  const chave = motoboy.chavePix || motoboy.ChavePix || '';
  await _assign(idPedido, fone, nome, chave);
}

/**
 * Chamado pelo handler de mensagens privadas.
 * @returns {boolean} true se a mensagem faz parte do fluxo de cadastro
 */
// TODO: reativar junto com startRegistration
async function handlePrivateReply(jid, text) {
  return false;
  const session = db.getMotoboySession(jid); // eslint-disable-line no-unreachable
  if (session.state === 'confirmed' && session.confirmed_at === today()) return false;

  if (session.state === 'awaiting_data') {
    return _handleAwaitingData(session, jid, text);
  }

  if (session.state === 'awaiting_confirmation') {
    return _handleAwaitingConfirmation(session, jid, text);
  }

  if (session.state === 'awaiting_key_update') {
    return _handleAwaitingKeyUpdate(session, jid, text);
  }

  return false;
}

async function _handleAwaitingData(session, jid, text) {
  const buffer = JSON.parse(session.data_buffer || '[]');
  buffer.push(text);

  console.log(`[REG] ${session.fone} — tentando extrair dados (${buffer.length} msg(s))...`);
  const { nome, chave } = await extractNameAndPix(buffer);

  if (nome && chave) {
    db.upsertMotoboySession({
      ...session,
      state: 'awaiting_confirmation',
      nome, chave,
      data_buffer: '[]',
      updated_at: now(),
    });

    await waClient.sendText(
      jid,
      `Só confirmar: seu nome é *${nome}* e sua chave PIX é *${chave}*? (sim / não)`
    );
    console.log(`[REG] ${session.fone} — dados extraídos. Nome="${nome}", PIX="${chave}".`);
  } else {
    db.upsertMotoboySession({
      ...session,
      data_buffer: JSON.stringify(buffer),
      updated_at: now(),
    });

    // Após 3 tentativas sem extrair, pede de forma mais direta
    if (buffer.length >= 3) {
      await waClient.sendText(
        jid,
        `Não consegui identificar seus dados. Me manda seu nome completo e chave PIX separados, por exemplo:\nJoão Silva\n11999990000`
      );
      db.upsertMotoboySession({
        ...session,
        data_buffer: '[]',
        updated_at: now(),
      });
    }
  }

  return true;
}

async function _handleAwaitingConfirmation(session, jid, text) {
  const resultado = await interpretConfirmation(text);
  console.log(`[REG] ${session.fone} — confirmação: "${text}" → ${resultado}`);

  if (resultado === 'sim') {
    await _assign(session.id_pedido, session.fone, session.nome, session.chave);
    db.upsertMotoboySession({
      ...session,
      state: 'confirmed',
      confirmed_at: today(),
      updated_at: now(),
    });
    await waClient.sendText(jid, `Perfeito! Cadastrado da chave efetuado ✅`);
  } else if (resultado === 'nao') {
    db.upsertMotoboySession({
      ...session,
      state: 'awaiting_data',
      nome: null, chave: null,
      data_buffer: '[]',
      updated_at: now(),
    });
    await waClient.sendText(jid, `Tudo bem! Me manda seu nome e a chave PIX correta 👍`);
  } else {
    await waClient.sendText(jid, `Responde com *sim* ou *não* por favor 😊`);
  }

  return true;
}

async function _handleAwaitingKeyUpdate(session, jid, text) {
  const result = await interpretKeyResponse(text);

  if (result.action === 'ignore') {
    console.log(`[REG] ${session.fone} — mensagem irrelevante para chave PIX. Aguardando.`);
    return true;
  }

  if (result.action === 'confirm') {
    db.upsertMotoboySession({ ...session, state: 'confirmed', confirmed_at: today(), updated_at: now() });
    console.log(`[REG] ${session.fone} — chave confirmada. Encerrando escuta.`);
    return true;
  }

  // action === 'update'
  console.log(`[REG] ${session.fone} — nova chave PIX: "${result.chave}". Atualizando...`);
  try {
    await crmClient.updateMotoboyKey(session.id_pedido, result.chave);
    db.upsertMotoboySession({ ...session, chave: result.chave, state: 'confirmed', confirmed_at: today(), updated_at: now() });
    await waClient.sendText(jid, `Chave atualizada para *${result.chave}* ✅`);
    console.log(`[REG] ${session.fone} — chave atualizada com sucesso. Encerrando escuta.`);
  } catch (err) {
    console.error(`[REG] Falha ao atualizar chave de ${session.fone}:`, err.message);
  }

  return true;
}

async function _assign(idPedido, fone, nome, chave) {
  try {
    await crmClient.assignMotoboy({ IdPedido: idPedido, Fone: fone, Nome: nome, Chave: chave });
    console.log(`[REG] ${nome} (${fone}) atribuído ao pedido ${idPedido}.`);
  } catch (err) {
    console.error(`[REG] Falha ao atribuir pedido ${idPedido}:`, err.message);
  }
}

module.exports = { startRegistration, handlePrivateReply };
