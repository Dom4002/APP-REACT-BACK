// 📁 backend/src/config/emailAssets.js

const path = require('path');

// ============================================================
// CONFIGURATION DES LOGOS POUR EMAILS
// ============================================================

// 📌 URL DU BACKEND - Utiliser l'URL de production ou localhost
const BACKEND_URL = process.env.BACKEND_URL || 'https://app-react-back.onrender.com';

// 📌 URLs des logos - Servis par le backend
const PUBLIC_URLS = {
  // Logo principal (général)
  logoGeneralIcon: `${BACKEND_URL}/assets/emails/logo-general-icon.png`,
  logoGeneralText: `${BACKEND_URL}/assets/emails/logo-general-text.png`,
  logoGeneralWhite: `${BACKEND_URL}/assets/emails/logo-general-white-bg.png`,
  
  // Logo Maman & Bébé
  logoMamanIcon: `${BACKEND_URL}/assets/emails/logo-maman-icon.png`,
  logoMamanText: `${BACKEND_URL}/assets/emails/logo-maman-text.png`,
  logoMamanWhite: `${BACKEND_URL}/assets/emails/logo-maman-white-bg.jpeg`,
};

// 📌 URLs de fallback (si le backend est hors ligne)
const FALLBACK_URLS = {
  logoGeneral: 'https://via.placeholder.com/200x60/1a4a3a/ffffff?text=Sant%C3%A9+Plus',
  logoMaman: 'https://via.placeholder.com/200x60/db4a6d/ffffff?text=Maman+%26+B%C3%A9b%C3%A9',
  logoAidant: 'https://via.placeholder.com/200x60/2c6e5c/ffffff?text=Aidant',
};

// ============================================================
// FONCTIONS
// ============================================================

const getLogoForEmail = (type = 'general', variant = 'default') => {
  let logoKey;
  
  if (type === 'maman') {
    logoKey = variant === 'white' ? 'logoMamanWhite' : 'logoMamanIcon';
  } else if (type === 'aidant') {
    logoKey = variant === 'white' ? 'logoGeneralWhite' : 'logoGeneralIcon';
  } else {
    logoKey = variant === 'white' ? 'logoGeneralWhite' : 'logoGeneralIcon';
  }
  
  const url = PUBLIC_URLS[logoKey];
  if (!url) {
    console.warn(`⚠️ Logo non trouvé pour ${logoKey}, utilisation du fallback`);
    return FALLBACK_URLS.logoGeneral;
  }
  
  return url;
};

const getLogoTextForEmail = (type = 'general') => {
  if (type === 'maman') {
    return PUBLIC_URLS.logoMamanText || FALLBACK_URLS.logoMaman;
  }
  return PUBLIC_URLS.logoGeneralText || FALLBACK_URLS.logoGeneral;
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  PUBLIC_URLS,
  FALLBACK_URLS,
  getLogoForEmail,
  getLogoTextForEmail,
  IS_PRODUCTION: process.env.NODE_ENV === 'production',
};
