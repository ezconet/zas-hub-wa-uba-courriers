const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

async function _invoke(prompt) {
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  }));
  const parsed = JSON.parse(new TextDecoder().decode(res.body));
  return parsed.content[0].text.trim();
}

/**
 * Tenta extrair nome e chave PIX de mensagens livres de motoboys.
 * @param {string[]} messages
 * @returns {{ nome: string|null, chave: string|null }}
 */
async function extractNameAndPix(messages) {
  const joined = messages.join('\n');
  const prompt = `Você está extraindo dados de pagamento de mensagens informais de motoboys brasileiros no WhatsApp.
Extraia o nome (primeiro nome ou nome completo) e a chave PIX (pode ser CPF, telefone com DDD, email ou chave aleatória).
Ignore palavras como "a caminho", "ok", "sim", saudações e frases que não são dados.

Mensagens:
${joined}

Responda SOMENTE com JSON válido, sem texto extra:
{"nome": "Nome ou null", "chave": "chave_pix ou null"}`;

  try {
    const text = await _invoke(prompt);
    const json = JSON.parse(text);
    return {
      nome: json.nome && json.nome !== 'null' ? String(json.nome).trim() : null,
      chave: json.chave && json.chave !== 'null' ? String(json.chave).trim() : null,
    };
  } catch (err) {
    console.warn('[AI] Falha ao extrair nome/PIX:', err.message);
    return { nome: null, chave: null };
  }
}

/**
 * Interpreta se a resposta é uma confirmação ou negação.
 * @param {string} text
 * @returns {'sim' | 'nao' | 'inconclusivo'}
 */
async function interpretConfirmation(text) {
  const prompt = `Um motoboy brasileiro respondeu no WhatsApp confirmando ou negando seus dados de pagamento.
Mensagem: "${text}"
Responda SOMENTE com uma palavra: sim, nao, ou inconclusivo`;

  try {
    const response = await _invoke(prompt);
    const clean = response.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (clean.startsWith('sim')) return 'sim';
    if (clean.startsWith('nao') || clean.startsWith('não')) return 'nao';
    return 'inconclusivo';
  } catch (err) {
    console.warn('[AI] Falha ao interpretar confirmação:', err.message);
    return 'inconclusivo';
  }
}

/**
 * Interpreta a resposta do motoboy após ser informado da chave PIX atual.
 * Retorna uma das três ações possíveis em uma única chamada ao modelo.
 * @param {string} text
 * @returns {Promise<{ action: 'update', chave: string } | { action: 'confirm' } | { action: 'ignore' }>}
 */
async function interpretKeyResponse(text) {
  const prompt = `Um motoboy brasileiro recebeu a informação de qual chave PIX será usada para seu pagamento e respondeu no WhatsApp.
Analise a mensagem e classifique a ação:
- "update": ele está informando uma NOVA chave PIX diferente (CPF, telefone com DDD, email ou UUID)
- "confirm": ele está confirmando que a chave atual está correta (ex: "sim", "é essa", "pode ser", "tá certo")
- "ignore": a mensagem não é relevante para a chave PIX

Mensagem: "${text}"

Responda SOMENTE com JSON válido:
- Se "update": {"action": "update", "chave": "valor_da_chave"}
- Se "confirm": {"action": "confirm"}
- Se "ignore": {"action": "ignore"}`;

  try {
    const response = await _invoke(prompt);
    const json = JSON.parse(response);
    if (json.action === 'update' && json.chave && json.chave !== 'null') {
      return { action: 'update', chave: String(json.chave).trim() };
    }
    if (json.action === 'confirm') return { action: 'confirm' };
    return { action: 'ignore' };
  } catch (err) {
    console.warn('[AI] Falha ao interpretar resposta de chave:', err.message);
    return { action: 'ignore' };
  }
}

module.exports = { extractNameAndPix, interpretConfirmation, interpretKeyResponse };
