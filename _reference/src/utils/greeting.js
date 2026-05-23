function getSaudacao() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Bom dia!\n\n';
  if (hour >= 18) return 'Boa noite!\n\n';
  return 'Boa tarde!\n\n';
}

module.exports = { getSaudacao };
