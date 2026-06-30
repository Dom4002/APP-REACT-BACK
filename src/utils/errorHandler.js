// 📁 backend/src/utils/errorHandler.js

// ============================================================
// CLASSES D'ERREURS PERSONNALISÉES
// ============================================================

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Non authentifié') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Accès non autorisé') {
    super(message, 403, 'AUTHORIZATION_ERROR');
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Ressource') {
    super(`${resource} non trouvé(e)`, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflit avec une ressource existante') {
    super(message, 409, 'CONFLICT_ERROR');
  }
}

// ============================================================
// FORMATTEUR DE RÉPONSE D'ERREUR
// ============================================================

const formatErrorResponse = (err, req) => {
  const isDevelopment = process.env.NODE_ENV === 'development';

  const response = {
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Erreur interne du serveur',
      status: err.statusCode || 500,
      path: req.path,
      method: req.method,
      timestamp: new Date().toISOString(),
    },
  };

  // ✅ En développement, ajouter la stack trace et les détails
  if (isDevelopment) {
    response.error.stack = err.stack;
    response.error.details = err.details || null;
  }

  // ✅ En production, cacher les détails sensibles
  if (process.env.NODE_ENV === 'production' && err.statusCode >= 500) {
    response.error.message = 'Une erreur est survenue. Veuillez réessayer plus tard.';
    response.error.details = null;
  }

  return response;
};

// ============================================================
// MIDDLEWARE D'ERREUR EXPRESS
// ============================================================

const errorHandler = (err, req, res, next) => {
  console.error('❌ Erreur:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    body: req.body,
    query: req.query,
    params: req.params,
  });

  // ✅ Si l'erreur est déjà une AppError
  if (err instanceof AppError) {
    const response = formatErrorResponse(err, req);
    return res.status(err.statusCode).json(response);
  }

  // ✅ Erreur de validation Supabase
  if (err.code === '23505') {
    const conflictError = new ConflictError('Une ressource avec ces données existe déjà');
    const response = formatErrorResponse(conflictError, req);
    return res.status(409).json(response);
  }

  // ✅ Erreur de validation Supabase (contrainte)
  if (err.code === '23502') {
    const validationError = new ValidationError('Données manquantes ou invalides');
    const response = formatErrorResponse(validationError, req);
    return res.status(400).json(response);
  }

  // ✅ Erreur de validation Supabase (format)
  if (err.code === '22P02') {
    const validationError = new ValidationError('Format de données invalide');
    const response = formatErrorResponse(validationError, req);
    return res.status(400).json(response);
  }

  // ✅ Erreur de validation Joi (si utilisé ailleurs)
  if (err.isJoi) {
    const validationError = new ValidationError(
      'Données invalides',
      err.details.map((d) => d.message)
    );
    const response = formatErrorResponse(validationError, req);
    return res.status(400).json(response);
  }

  // ✅ Erreur de syntaxe JSON
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    const validationError = new ValidationError('JSON invalide');
    const response = formatErrorResponse(validationError, req);
    return res.status(400).json(response);
  }

  // ✅ Erreur générique
  const genericError = new AppError(
    process.env.NODE_ENV === 'development' ? err.message : 'Erreur interne du serveur',
    500,
    err.code || 'INTERNAL_ERROR'
  );
  const response = formatErrorResponse(genericError, req);
  return res.status(500).json(response);
};

// ============================================================
// MIDDLEWARE DE ROUTE NON TROUVÉE
// ============================================================

const notFoundHandler = (req, res, next) => {
  const error = new NotFoundError(`Route ${req.method} ${req.path}`);
  next(error);
};

// ============================================================
// WRAPPER POUR LES ROUTES ASYNCHRONES
// ============================================================

const asyncWrapper = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  errorHandler,
  notFoundHandler,
  asyncWrapper,
  formatErrorResponse,
};
