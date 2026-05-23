/**
 * Gera URL do Google Maps Search para um endereço.
 * Segue a mesma lógica do código C# original (duplo encode).
 * @param {string} address - Endereço completo (rua, número, bairro, cidade)
 * @returns {string}
 */
function buildMapUrl(address) {
  const primeiraCamada = encodeURIComponent(address);
  //const segundaCamada = encodeURIComponent(primeiraCamada);
  return `https://www.google.com/maps/search/${primeiraCamada}`;
}

module.exports = { buildMapUrl };
