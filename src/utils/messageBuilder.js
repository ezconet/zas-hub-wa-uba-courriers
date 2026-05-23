const { getSaudacao } = require('./greeting');
const { buildMapUrl } = require('./mapLink');

/**
 * MSG GRUPO - Solicitação de corrida enviada no grupo de motoboys.
 */
function buildGroupMessage({ displayId, neighborhood, bairroRetirada }) {
  return `Entrega ${neighborhood}\n\nPedido Ifood ${displayId}\n\nRetira no(a) ${bairroRetirada}`;
}

/**
 * MSG 1 - Endereço de RETIRADA enviado privativamente ao motoboy.
 */
function buildMsg1(orderData, merchant) {
  const saudacao = getSaudacao();
  const addressForMap = `${merchant.pickupAddress},${merchant.pickupBairro},Ubatuba`;
  const mapUrl = buildMapUrl(addressForMap);

  return (
    `${saudacao}Retirada: Restaurante ${merchant.name} \n\n ` +
    `${merchant.pickupAddress} - ${merchant.pickupBairro}` +
    `\n\nRota de *RETIRADA* no Google Maps: ${mapUrl}`
  );
}

/**
 * MSG 2 - Endereço de ENTREGA enviado privativamente ao motoboy.
 */
function buildMsg2(orderData) {
  const e = orderData.delivery.deliveryAddress;

  let addressLine = `${e.streetName}, ${e.streetNumber}`;
  if (e.complement) addressLine += ` Complemento: ${e.complement}`;
  if (e.reference) addressLine += ` Referencia: ${e.reference}`;

  const addressForMap = `${e.streetName},${e.streetNumber},${e.neighborhood},Ubatuba`;
  const mapUrl = buildMapUrl(addressForMap);

  return (
    `Entrega \n\nPedido: ${orderData.displayId} \n\n` +
    `Cliente: ${orderData.customer.name}\n\n` +
    `Endereço: ${addressLine} \n\nBairro: ${e.neighborhood}` +
    `\n\nRota de *ENTREGA* no Google Maps: ${mapUrl}`
  );
}

/**
 * MSG 3 - Link de confirmação do iFood enviado privativamente ao motoboy.
 */
function buildMsg3(orderData) {
  return (
    `*Solicitar o Código* e confirmar neste link  \n\n` +
    `https://www.mobifyme.com.br/delivery/confirmacao.html?orderId=${orderData.id}`
  );
}

module.exports = { buildGroupMessage, buildMsg1, buildMsg2, buildMsg3 };
