// 📁 backend/server.js

require('dotenv').config();
const { validateEnv } = require('./src/config/validateEnv');
validateEnv();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { errorHandler, notFoundHandler } = require('./src/utils/errorHandler');
const { logRequest } = require('./src/config/logger');
const { setupSwagger } = require('./src/config/swagger');
const aidantCatalogRoutes = require('./src/routes/aidantCatalog.routes');

const app = express();

const path = require('path');
const fs = require('fs');

// =============================================
// ✅ SERVIR LES FICHIERS STATIQUES (LOGOS)
// =============================================

// 1. Servir tout le dossier assets
app.use('/assets', express.static(path.join(__dirname, 'src/assets')));

// 2. Route spécifique pour les logos
app.get('/logos/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'src/assets/emails', filename);
  
  // Vérifier si le fichier existe
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Logo non trouvé' });
  }
});

console.log('📁 Assets servis depuis /assets');
console.log('📁 Logos disponibles sur /logos/:filename');

const PORT = process.env.PORT || 5000;

// =============================================
// SUPABASE CLIENT
// =============================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =============================================
// MIDDLEWARES
// =============================================
app.use(helmet());
app.set('trust proxy', true);

app.use(logRequest); // ✅ Logger

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://app-sante-plus-react-front.vercel.app'
  ],
  credentials: true,
}));

// ⚠️ IMPORTANT : Webhook FedaPay DOIT être AVANT express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes, veuillez réessayer plus tard' },
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
  },
});
app.use('/api', limiter);

// =============================================
// ROUTES
// =============================================
const authRoutes = require('./src/routes/auth.routes');
const patientRoutes = require('./src/routes/patient.routes');
const visitRoutes = require('./src/routes/visit.routes');
const orderRoutes = require('./src/routes/order.routes');
const messageRoutes = require('./src/routes/message.routes');
const paymentRoutes = require('./src/routes/payment.routes');
const adminRoutes = require('./src/routes/admin.routes');
const notificationRoutes = require('./src/routes/notification.routes');
const billingRoutes = require('./src/routes/billing');
const reminderRoutes = require('./src/routes/reminder.routes');
const assessmentRoutes = require('./src/routes/assessment.routes');
const contractRoutes = require('./src/routes/contract.routes');
const adminSetupRoutes = require('./src/routes/adminSetup.routes');
const settingsRoutes = require('./src/routes/settings.routes');
const offerRoutes = require('./src/routes/offers.routes');

app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/visits', visitRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/contract', contractRoutes);
app.use('/api/admin-setup', adminSetupRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/aidants', aidantCatalogRoutes); 


// =============================================
// ✅ REDIRECTION FEDAPAY
// =============================================
app.post('/payment/confirm', express.json(), async (req, res) => {
  console.log('📥 Redirection FedaPay reçue:', req.body);
  
  const { transaction_id, status } = req.body;
  
  if (status === 'approved' || status === 'paid') {
    await supabase
      .from('paiements')
      .update({ status: 'valide', paid_at: new Date().toISOString() })
      .eq('reference', transaction_id);
  }
  
  res.redirect(`${process.env.CLIENT_URL}/payment/confirm?status=${status}&transaction_id=${transaction_id}`);
});

// =============================================
// HEALTH CHECK
// =============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Santé Plus API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// =============================================
// SWAGGER DOCUMENTATION
// =============================================
setupSwagger(app);

// =============================================
// 404 - Route non trouvée (UN SEUL)
// =============================================
app.use(notFoundHandler);

// =============================================
// GESTIONNAIRE D'ERREURS GLOBAL (UN SEUL)
// =============================================
app.use(errorHandler);

// =============================================
// START SERVER
// =============================================
app.listen(PORT, () => {
  console.log(`🚀 Santé Plus API running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📚 Swagger: http://localhost:${PORT}/api/docs`);
  console.log(`💳 Webhook FedaPay: http://localhost:${PORT}/api/billing/webhook`);
  console.log(`↩️ Redirection FedaPay: http://localhost:${PORT}/payment/confirm`);
});


// 📁 server.js - Ajouter ces endpoints avant le démarrage du serveur

// =============================================
// ✅ HEALTH CHECK - Pour Keep-Alive
// =============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Santé Plus API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// =============================================
// ✅ BILLING HEALTH
// =============================================
app.get('/billing/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Billing API',
    fedapay_env: process.env.FEDAPAY_ENV || 'live',
    timestamp: new Date().toISOString(),
  });
});



module.exports = app;
