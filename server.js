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
const fileUpload = require('express-fileupload');

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

app.use(logRequest);

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://app-sante-plus-react-front.vercel.app',
    'https://app-sante-plus-react-front-git-main-abouamhster-cmyks-projects.vercel.app'
  ],
  credentials: true,
}));

// ⚠️ IMPORTANT : Webhook FedaPay DOIT être AVANT express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ✅ File upload pour les messages
app.use(fileUpload({
  limits: { fileSize: 5 * 1024 * 1024 },
  abortOnLimit: true,
}));

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
// MIDDLEWARES D'AUTH (IMPORTÉS)
// =============================================
const authMiddleware = require('./src/middleware/auth.middleware');
const roleMiddleware = require('./src/middleware/role.middleware');

// =============================================
// ✅ ROUTES - UNE SEULE FOIS CHAQUE
// =============================================
const authRoutes = require('./src/routes/auth.routes');
const patientRoutes = require('./src/routes/patient.routes');
const visitRoutes = require('./src/routes/visit.routes');
const orderRoutes = require('./src/routes/order.routes');
const messageRoutes = require('./src/routes/message.routes'); // ✅ CONSERVÉ
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

// ✅ UNE SEULE DÉCLARATION POUR CHAQUE ROUTE
const aidantCatalogRoutes = require('./src/routes/aidantCatalog.routes');
const aidantAssignmentsRoutes = require('./src/routes/aidantAssignments.routes');

// ✅ DEBUG
console.log('📋 === ROUTES D\'ASSIGNATION ===');
console.log('📋 aidantAssignmentsRoutes:', !!aidantAssignmentsRoutes);
if (aidantAssignmentsRoutes) {
  console.log('📋 Type:', typeof aidantAssignmentsRoutes);
  console.log('📋 Routes disponibles:', aidantAssignmentsRoutes.stack?.map(r => {
    const routePath = r.route?.path || r.path || '?';
    const methods = r.route?.methods ? Object.keys(r.route.methods).join(',') : '?';
    return `${methods.toUpperCase()} ${routePath}`;
  }) || []);
}
console.log('📋 ================================');

// =============================================
// ✅ APPLICATION DES ROUTES
// =============================================
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
app.use('/api/assignments', aidantAssignmentsRoutes);

 
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

app.get('/billing/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Billing API',
    fedapay_env: process.env.FEDAPAY_ENV || 'live',
    timestamp: new Date().toISOString(),
  });
});

// =============================================
// SWAGGER DOCUMENTATION
// =============================================
setupSwagger(app);

// =============================================
// 404 - Route non trouvée
// =============================================
app.use(notFoundHandler);

// =============================================
// GESTIONNAIRE D'ERREURS GLOBAL
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
  console.log(`📋 Routes d'assignation: http://localhost:${PORT}/api/assignments`);
});

module.exports = app;
