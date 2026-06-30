// 📁 backend/src/config/validateEnv.js
const Joi = require('joi');

// ============================================================
// SCHÉMA DE VALIDATION DES VARIABLES D'ENVIRONNEMENT
// ============================================================

const envSchema = Joi.object({
  // =============================================
  // SERVER
  // =============================================
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(5000),

  // =============================================
  // SUPABASE
  // =============================================
  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),

  // =============================================
  // FEDAPAY
  // =============================================
  FEDAPAY_SECRET_KEY: Joi.string().required(),
  FEDAPAY_ENV: Joi.string()
    .valid('live', 'sandbox')
    .default('live'),

  // =============================================
  // FRONTEND
  // =============================================
  CLIENT_URL: Joi.string().uri().required(),
  FRONTEND_URL: Joi.string().uri().required(),

  // =============================================
  // BREVO (EMAIL)
  // =============================================
  BREVO_API_KEY: Joi.string().required(),
  BREVO_SENDER_EMAIL: Joi.string().email().required(),

  // =============================================
  // FIREBASE (Notifications)
  // =============================================
  FIREBASE_PROJECT_ID: Joi.string().required(),
  FIREBASE_PRIVATE_KEY: Joi.string().required(),
  FIREBASE_CLIENT_EMAIL: Joi.string().email().required(),

  // =============================================
  // ASSETS (optionnel)
  // =============================================
  ASSETS_URL: Joi.string().uri().optional(),
}).unknown(true);

// ============================================================
// FONCTION DE VALIDATION
// ============================================================

const validateEnv = () => {
  const { error, value } = envSchema.validate(process.env, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const errors = error.details.map((detail) => detail.message).join('\n');
    console.error('❌ Erreur de validation des variables d\'environnement:');
    console.error(errors);
    console.error('\n⚠️ Vérifiez votre fichier .env ou les variables d\'environnement.');
    process.exit(1);
  }

  console.log('✅ Variables d\'environnement validées avec succès');
  return value;
};

module.exports = { validateEnv };
