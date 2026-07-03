// 📁 backend/src/services/email.service.js

const axios = require('axios');
const { getLogoForEmail } = require('../config/emailAssets');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_URL = 'https://api.brevo.com/v3';

// ✅ URL DU SITE
const SITE_URL = process.env.VERCEL_URL 
  ? `${process.env.VERCEL_URL}`
  : process.env.CLIENT_URL || 'https://app-sante-plus-react.vercel.app';

console.log('🌐 SITE_URL:', SITE_URL);

// ============================================================
// ENVOI D'EMAIL AVEC RETRY
// ============================================================

const sendEmail = async ({ to, subject, htmlContent, textContent, sender = { name: 'Santé Plus Services', email: process.env.BREVO_SENDER_EMAIL } }) => {
  try {
    if (!htmlContent && !textContent) {
      throw new Error('Either htmlContent or textContent is required');
    }

    const payload = {
      sender,
      to: Array.isArray(to) ? to.map(email => ({ email })) : [{ email: to }],
      subject,
      htmlContent: htmlContent || textContent,
    };

    console.log('📧 Sending email to:', to);
    console.log('📧 Subject:', subject);

    const response = await axios.post(
      `${BREVO_URL}/smtp/email`,
      payload,
      {
        headers: {
          'api-key': BREVO_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('❌ Brevo email error:', error.response?.data || error.message);
    throw error;
  }
};

// ============================================================
// DÉTECTION DU TYPE DE BRANDING
// ============================================================

const detectBrandingType = (data = {}) => {
  if (data.type) return data.type;
  if (data.patient_category === 'maman_bebe') return 'maman';
  if (data.patient_category === 'senior') return 'senior';
  if (data.role === 'aidant') return 'aidant';
  if (data.role === 'coordinator') return 'coordinator';
  if (data.role === 'admin') return 'coordinator';
  return 'general';
};

const getBrandingColors = (type) => {
  switch (type) {
    case 'maman':
      return { brandColor: '#db4a6d', secondaryColor: '#f5d0d8', accentColor: '#e8436a' };
    case 'aidant':
      return { brandColor: '#2c6e5c', secondaryColor: '#b8d5cc', accentColor: '#3a8a72' };
    case 'coordinator':
    case 'admin':
      return { brandColor: '#1a4a3a', secondaryColor: '#c9a84c', accentColor: '#2a6a4a' };
    default:
      return { brandColor: '#1a4a3a', secondaryColor: '#c9a84c', accentColor: '#2a6a4a' };
  }
};

// ============================================================
// GÉNÉRATEUR DE STYLES
// ============================================================

const getEmailStyles = (brandColor = '#1a4a3a', secondaryColor = '#c9a84c') => `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background-color: #f8f6f2;
    -webkit-font-smoothing: antialiased;
  }
  .container {
    max-width: 600px;
    margin: 0 auto;
    padding: 24px 20px;
    background-color: #f8f6f2;
  }
  .card {
    background-color: #ffffff;
    border-radius: 20px;
    padding: 40px 36px;
    box-shadow: 0 2px 16px rgba(0, 0, 0, 0.04);
    border: 1px solid #ece8e2;
  }
  .header {
    text-align: center;
    margin-bottom: 28px;
    padding-bottom: 24px;
    border-bottom: 2px solid ${secondaryColor}22;
  }
  .logo-wrapper {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .logo-icon { max-height: 100px; width: auto; display: block; }
  .brand-name {
    display: block;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: ${brandColor};
    margin-top: 4px;
  }
  .title {
    font-size: 24px;
    font-weight: 700;
    color: ${brandColor};
    margin-top: 12px;
    margin-bottom: 4px;
    line-height: 1.3;
  }
  .subtitle {
    color: #6b7280;
    font-size: 15px;
    line-height: 1.6;
  }
  .divider { border: none; border-top: 1px solid #ece8e2; margin: 28px 0; }
  .footer {
    text-align: center;
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid #ece8e2;
  }
  .footer-text { color: #9ca3af; font-size: 12px; line-height: 1.8; }
  .footer-text strong { color: #6b7280; }
  .btn-primary {
    display: inline-block;
    background: ${brandColor};
    color: #ffffff !important;
    padding: 13px 36px;
    border-radius: 12px;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    margin-top: 8px;
  }
  .btn-primary:hover { opacity: 0.85; }
  .highlight-box {
    background: ${brandColor}06;
    border-radius: 16px;
    padding: 24px 20px;
    margin: 24px 0;
    text-align: center;
    border: 1px solid ${brandColor}15;
  }
  .highlight-box.dashed {
    border-style: dashed;
    border-color: ${secondaryColor};
    background: ${brandColor}04;
  }
  .status-badge {
    display: inline-block;
    padding: 6px 16px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    margin: 8px 0;
  }
  .status-pending {
    background: #fef3c7;
    color: #92400e;
  }
  .status-approved {
    background: #d1fae5;
    color: #065f46;
  }
  .status-rejected {
    background: #fee2e2;
    color: #991b1b;
  }
  @media only screen and (max-width: 480px) {
    .card { padding: 24px 16px; }
    .logo-icon { max-height: 80px; }
    .title { font-size: 20px; }
    .btn-primary { display: block; text-align: center; }
  }
`;

const generateFooter = () => `
  <div class="footer">
    <p class="footer-text">
      <strong>Santé Plus Services</strong><br>
      Cotonou, Bénin<br>
      📧 <a href="mailto:contact@santeplus.bj" style="color:#6b7280;text-decoration:none;">contact@santeplus.bj</a> 
      | 📞 <a href="tel:+2290191343458" style="color:#6b7280;text-decoration:none;">+229 01 91 34 34 58</a>
      <br>
      <a href="${SITE_URL}" style="color:#6b7280;text-decoration:none;font-size:12px;">🌐${SITE_URL}</a>
    </p>
    <p class="footer-text" style="margin-top:8px; font-size:11px; color:#d1d5db;">
      © ${new Date().getFullYear()} Santé Plus Services — Tous droits réservés
    </p>
  </div>
`;

// ============================================================
// TEMPLATES
// ============================================================

const templates = {

  // ============================================================
  // 1. BIENVENUE - FAMILLE (compte validé immédiatement)
  // ============================================================
  welcomeFamily: (name, data = {}) => {
    const type = detectBrandingType(data);
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);
    const loginUrl = `${SITE_URL}login`;

    return {
      subject: '✅ Bienvenue chez Santé Plus Services !',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Bienvenue</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail(type)}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title">Bienvenue ${name} 👋</h1>
                <p class="subtitle">Nous sommes ravis de vous compter parmi nous.</p>
              </div>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                Votre compte a été créé avec succès. Vous pouvez dès maintenant accéder à votre espace personnel.
              </p>
              <div style="text-align: center; margin: 24px 0;">
                <a href="${loginUrl}" class="btn-primary">Accéder à mon compte</a>
              </div>
              <div class="highlight-box">
                <p style="color: #4b5563; font-size: 14px; margin:0;">
                  💡 <strong>Conseil :</strong> Complétez votre profil pour une meilleure expérience.
                </p>
              </div>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // ============================================================
  // 2. BIENVENUE - AIDANT (en attente de validation)
  // ============================================================
  welcomeAidant: (name, data = {}) => {
    const type = 'aidant';
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);
    const loginUrl = `${SITE_URL}login`;

    return {
      subject: '📋 Candidature aidant - En attente de validation',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Candidature aidant</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail('aidant')}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title">Merci pour votre candidature 🦸</h1>
                <p class="subtitle">Bonjour ${name},</p>
              </div>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                Nous avons bien reçu votre candidature pour rejoindre l'équipe d'aidants de <strong>Santé Plus Services</strong>.
              </p>
              <div class="highlight-box dashed">
                <div style="display: inline-block; padding: 8px 24px; border-radius: 20px; background: #fef3c7; color: #92400e; font-weight: 600; font-size: 14px;">
                  ⏳ En attente de validation
                </div>
                <p style="color: #6b7280; font-size: 14px; margin-top: 12px;">
                  Notre équipe examine votre dossier dans les plus brefs délais.
                </p>
                <p style="color: #92400e; font-size: 13px; margin-top: 8px;">
                  ⏱️ Délai estimé : <strong>24 à 48 heures</strong>
                </p>
              </div>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7;">
                Dès que votre compte sera validé, vous recevrez un email de confirmation et pourrez commencer à accepter des missions.
              </p>
              <div style="text-align: center; margin: 20px 0;">
                <a href="${loginUrl}" class="btn-primary">Suivre ma candidature</a>
              </div>
              <div style="background: #f0f7f4; border-radius: 12px; padding: 16px; margin-top: 20px;">
                <p style="color: #2c6e5c; font-size: 13px; margin:0;">
                  💡 <strong>À savoir :</strong> Vous pouvez déjà consulter votre profil et compléter vos informations en attendant la validation.
                </p>
              </div>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // ============================================================
  // 3. AIDANT APPROUVÉ
  // ============================================================
  aidantApproved: (name, data = {}) => {
    const type = 'aidant';
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);
    const loginUrl = `${SITE_URL}login`;
    const missionsUrl = `${SITE_URL}app/missions`;

    return {
      subject: '✅ Votre compte aidant est approuvé !',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Compte approuvé</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail('aidant')}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title">🎉 Félicitations ${name} !</h1>
                <p class="subtitle">Votre compte aidant a été approuvé</p>
              </div>
              <div class="highlight-box" style="border-color:${colors.brandColor};">
                <div style="display: inline-block; padding: 8px 24px; border-radius: 20px; background: #d1fae5; color: #065f46; font-weight: 600; font-size: 14px;">
                  ✅ Compte validé
                </div>
                <p style="color: #065f46; font-size: 14px; margin-top: 12px;">
                  Vous pouvez dès maintenant commencer à accepter des missions !
                </p>
              </div>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7;">
                Nous avons le plaisir de vous annoncer que votre compte a été <strong>validé</strong> par notre équipe.
                Vous faites désormais partie de l'équipe Santé Plus Services.
              </p>
              <div style="background: #f0f7f4; border-radius: 12px; padding: 16px; margin: 20px 0;">
                <p style="color: #2c6e5c; font-size: 14px; font-weight: 600; margin-bottom: 8px;">🚀 Ce que vous pouvez faire maintenant :</p>
                <ul style="color: #4b5563; font-size: 14px; line-height: 2; padding-left: 20px;">
                  <li>📋 Consulter les missions disponibles</li>
                  <li>✅ Accepter des missions</li>
                  <li>📊 Suivre votre historique d'interventions</li>
                  <li>💬 Communiquer avec l'équipe</li>
                </ul>
              </div>
              <div style="text-align: center; margin: 24px 0; display: flex; gap: 12px; flex-wrap: wrap; justify-content: center;">
                <a href="${missionsUrl}" class="btn-primary" style="background: ${colors.brandColor};">Voir les missions</a>
                <a href="${loginUrl}" class="btn-primary" style="background: #6b7280;">Se connecter</a>
              </div>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // ============================================================
  // 4. AIDANT REFUSÉ
  // ============================================================
  aidantRejected: (name, data = {}) => {
    const type = 'aidant';
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);

    return {
      subject: 'Candidature Santé Plus - Information',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Candidature</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail('aidant')}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title" style="color: #991b1b;">Candidature - Information</h1>
              </div>
              <p class="subtitle">Bonjour ${name},</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                Nous vous remercions pour l'intérêt que vous avez porté à <strong>Santé Plus Services</strong>.
              </p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7;">
                Après examen de votre candidature, nous ne pouvons pas donner suite à votre demande pour le moment.
              </p>
              <div class="highlight-box" style="border-color: #fca5a5; background: #fef2f2;">
                <div style="display: inline-block; padding: 8px 24px; border-radius: 20px; background: #fee2e2; color: #991b1b; font-weight: 600; font-size: 14px;">
                  ❌ Candidature non retenue
                </div>
              </div>
              <p style="color: #9ca3af; font-size: 14px; margin-top: 12px;">
                Nous vous encourageons à postuler à nouveau ultérieurement ou à nous contacter pour plus d'informations.
              </p>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // ============================================================
  // 5. MOT DE PASSE OUBLIÉ
  // ============================================================
  forgotPassword: (name, resetLink, data = {}) => {
    const type = detectBrandingType(data);
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);
    const resetUrl = resetLink || `${SITE_URL}reset-password`;

    return {
      subject: '🔑 Réinitialisation de votre mot de passe',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Réinitialisation</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail(type)}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title">🔑 Réinitialisation</h1>
                <p class="subtitle">Bonjour ${name},</p>
              </div>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                Nous avons reçu une demande de réinitialisation de votre mot de passe.
              </p>
              <div style="text-align: center; margin: 24px 0;">
                <a href="${resetUrl}" class="btn-primary">Réinitialiser mon mot de passe</a>
              </div>
              <p style="color: #9ca3af; font-size: 13px; text-align: center;">
                ⏱️ Ce lien expire dans 1 heure.
              </p>
              <hr class="divider">
              <p style="color: #9ca3af; font-size: 13px; text-align: center; margin-top:12px;">
                Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.
              </p>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // ============================================================
  // 6. INSCRIPTION VALIDÉE (pour les aidants approuvés)
  // ============================================================
  registrationValidated: (data = {}) => {
    const type = detectBrandingType(data);
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);
    const loginUrl = `${SITE_URL}login`;
    const name = data.name || 'Utilisateur';
    const isAidant = data.role === 'aidant';

    return {
      subject: isAidant ? '✅ Votre compte aidant est validé !' : '✅ Votre inscription est validée !',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Inscription validée</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail(type)}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title">${isAidant ? '🎉 Félicitations !' : '✅ Inscription validée !'}</h1>
                <p class="subtitle">Bonjour ${name},</p>
              </div>
              <div class="highlight-box" style="border-color:${colors.brandColor};">
                <div style="display: inline-block; padding: 8px 24px; border-radius: 20px; background: #d1fae5; color: #065f46; font-weight: 600; font-size: 14px;">
                  ${isAidant ? '✅ Compte aidant validé' : '✅ Inscription validée'}
                </div>
              </div>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                ${isAidant 
                  ? `Nous avons le plaisir de vous annoncer que votre compte aidant a été <strong>validé</strong>. Vous pouvez dès maintenant commencer à accepter des missions.`
                  : `Nous avons le plaisir de vous informer que votre inscription a été <strong>validée</strong>. Vous pouvez dès maintenant accéder à tous nos services.`}
              </p>
              <div style="text-align: center; margin: 24px 0;">
                <a href="${loginUrl}" class="btn-primary">Se connecter</a>
              </div>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // ============================================================
  // 7. RAPPEL DE VISITE
  // ============================================================
  visitReminder: (data = {}) => {
    const type = detectBrandingType(data);
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);
    const visitsUrl = `${SITE_URL}app/visits`;

    return {
      subject: '📅 Rappel : Visite prévue',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Rappel de visite</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail(type)}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title">📅 Rappel de visite</h1>
              </div>
              <p class="subtitle">Bonjour,</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                Une visite est prévue pour <strong>${data.patient_name || 'le patient'}</strong> le <strong>${data.date || 'prochainement'}</strong> à <strong>${data.time || '---'}</strong>.
              </p>
              ${data.address ? `
              <div style="background: #f8f6f2; border-radius: 12px; padding: 12px 16px; margin: 12px 0;">
                <p style="color: #6b7280; font-size: 13px; margin:0;">
                  📍 <strong>Adresse :</strong> ${data.address}
                </p>
              </div>
              ` : ''}
              ${data.aidant_name ? `
              <p style="color: #4b5563; font-size: 14px;">
                🧑‍⚕️ Aidant : <strong>${data.aidant_name}</strong>
              </p>
              ` : ''}
              <div style="text-align: center; margin: 20px 0;">
                <a href="${visitsUrl}" class="btn-primary">Voir les détails</a>
              </div>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // ============================================================
  // 8. PAIEMENT CONFIRMÉ
  // ============================================================
  paymentConfirmed: (data = {}) => {
    const type = detectBrandingType(data);
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);
    const billingUrl = `${SITE_URL}app/billing`;

    return {
      subject: '✅ Paiement confirmé',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Paiement confirmé</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail(type)}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title">✅ Paiement confirmé</h1>
              </div>
              <p class="subtitle">Bonjour,</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                Nous vous confirmons la réception de votre paiement de <strong>${data.amount || '0'} FCFA</strong>.
              </p>
              ${data.plan_name ? `
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7;">
                Votre abonnement <strong>${data.plan_name}</strong> est maintenant actif.
              </p>
              ` : ''}
              <div style="text-align: center; margin: 20px 0;">
                <a href="${billingUrl}" class="btn-primary">Voir mes abonnements</a>
              </div>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // ============================================================
  // 9. ABONNEMENT EXPIRE
  // ============================================================
  subscriptionExpired: (data = {}) => {
    const type = detectBrandingType(data);
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);
    const billingUrl = `${SITE_URL}app/billing`;

    return {
      subject: '⏰ Votre abonnement arrive à expiration',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Abonnement expiration</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail(type)}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title">⏰ Abonnement bientôt expiré</h1>
              </div>
              <p class="subtitle">Bonjour,</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                Votre abonnement <strong>${data.plan_name || 'Santé Plus'}</strong> expire le <strong>${data.expiry_date || 'prochainement'}</strong>.
              </p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7;">
                Pour continuer à bénéficier de nos services, pensez à renouveler votre abonnement.
              </p>
              <div style="text-align: center; margin: 24px 0;">
                <a href="${billingUrl}" class="btn-primary">Renouveler mon abonnement</a>
              </div>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // ============================================================
  // 10. OTP - Code de vérification
  // ============================================================
  otp: (otp, expiresIn = 10, type = 'general') => {
    const colors = getBrandingColors(type);
    const styles = getEmailStyles(colors.brandColor, colors.secondaryColor);

    return {
      subject: '🔐 Code de vérification - Santé Plus Services',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Code de vérification</title><style>${styles}</style></head>
        <body>
          <div class="container">
            <div class="card">
              <div class="header">
                <div class="logo-wrapper">
                  <img src="${getLogoForEmail(type)}" alt="Santé Plus" class="logo-icon" />
                </div>
                <h1 class="title">🔐 Code de vérification</h1>
              </div>
              <p class="subtitle">Bonjour,</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                Vous avez demandé à créer un compte administrateur pour <strong>Santé Plus Services</strong>.
              </p>
              <div class="highlight-box dashed">
                <div style="font-size: 13px; color: #6b7280; font-weight: 500; margin-bottom: 6px;">Votre code de vérification est :</div>
                <div style="font-size: 38px; font-weight: 900; letter-spacing: 10px; color: ${colors.brandColor}; font-family: 'Courier New', monospace;">${otp}</div>
                <div style="font-size: 12px; color: #9ca3af; margin-top: 8px;">⏱️ Ce code expire dans ${expiresIn} minutes</div>
              </div>
              <p style="color: #6b7280; font-size: 14px; margin-top: 8px;">
                Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.
              </p>
              ${generateFooter()}
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },
};

// ============================================================
// EXPORT
// ============================================================

module.exports = { 
  sendEmail, 
  templates, 
  detectBrandingType, 
  getBrandingColors 
};
