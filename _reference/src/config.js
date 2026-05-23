require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  return val;
}

module.exports = {
  CRM_BASE_URL: required('CRM_BASE_URL'),
  WHATSAPP_GROUP_JID: required('WHATSAPP_GROUP_JID'),

  TEST_MODE: process.env.TEST_MODE === 'true',

  POLL_INTERVAL_CRON: process.env.POLL_INTERVAL_CRON || '*/30 * * * * *',
  EXPIRY_MINUTES: parseInt(process.env.EXPIRY_MINUTES || '30', 10),
  EXPIRY_CHECK_CRON: process.env.EXPIRY_CHECK_CRON || '*/5 * * * *',
  DB_PATH: process.env.DB_PATH || './data/orders.db',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  MERCHANTS: {
    'c943d847-0ab5-4147-aa02-68df78415ebf': {
      name: 'Zas',
      pickupAddress: 'Rua Capitao Felipe, 309',
      pickupBairro: 'Itagua',
    },
    '0e26ebcf-03db-4966-aadf-22fffe033209': {
      name: 'Zas',
      pickupAddress: 'Rua Capitao Felipe, 309',
      pickupBairro: 'Itagua',
    },
    'a636aa41-d070-47ef-9c12-983839147b01': {
      name: 'Nega',
      pickupAddress: 'Av. Atlantica, 220',
      pickupBairro: 'Praia Grande',
    },
    DEFAULT: {                                                                                  
      name: 'Restaurante',
      pickupAddress: 'Av. Atlantica, 220',
      pickupBairro: 'Praia Grande',
    },
  },
};
