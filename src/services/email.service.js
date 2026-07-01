// 📁 backend/src/services/email.service.js

const axios = require('axios');
const { getLogoForEmail } = require('../config/emailAssets');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_URL = 'https://api.brevo.com/v3';

// ✅ URL DU SITE - Utiliser Vercel en priorité
const SITE_URL = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}`
  : process.env.CLIENT_URL || 'https://app-sante-plus-react.vercel.app';

console.log('🌐 SITE_URL:', SITE_URL);

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

// =============================================
// GÉNÉRATEUR DE STYLES UNIFORMES
// =============================================

const getEmailStyles = (brandColor = '#1a4a3a', secondaryColor = '#c9a84c') => `
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  
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
  
  .logo-icon {
    max-height: 56px;
    width: auto;
    display: block;
  }
  
  .brand-name {
    display: block;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: ${brandColor};
    margin-top: 4px;
  }
  
  .brand-sub {
    display: block;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: ${brandColor}80;
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
  
  .divider {
    border: none;
    border-top: 1px solid #ece8e2;
    margin: 28px 0;
  }
  
  .footer {
    text-align: center;
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid #ece8e2;
  }
  
  .footer-text {
    color: #9ca3af;
    font-size: 12px;
    line-height: 1.8;
  }
  
  .footer-text strong {
    color: #6b7280;
  }
  
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
  
  .btn-primary:hover {
    opacity: 0.85;
  }
  
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
  
  .highlight-box .label {
    color: #6b7280;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 6px;
  }
  
  .highlight-box .code {
    font-size: 38px;
    font-weight: 900;
    letter-spacing: 10px;
    color: ${brandColor};
    font-family: 'Courier New', monospace;
  }
  
  .highlight-box .hint {
    color: #9ca3af;
    font-size: 12px;
    margin-top: 8px;
  }
  
  .info-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 16px 0;
  }
  
  .info-item {
    background: #f8f6f2;
    border-radius: 12px;
    padding: 12px 16px;
    text-align: center;
  }
  
  .info-item .label {
    color: #9ca3af;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .info-item .value {
    color: ${brandColor};
    font-size: 14px;
    font-weight: 600;
    margin-top: 2px;
  }
  
  .feature-list {
    list-style: none;
    padding: 0;
    margin: 12px 0;
  }
  
  .feature-list li {
    padding: 6px 0;
    color: #4b5563;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    justify-content: center;
  }
  
  .feature-list li::before {
    content: "✅";
    font-size: 14px;
  }
  
  @media only screen and (max-width: 480px) {
    .card {
      padding: 24px 16px;
    }
    
    .logo-icon {
      max-height: 44px;
    }
    
    .brand-name {
      font-size: 12px;
    }
    
    .brand-sub {
      font-size: 9px;
    }
    
    .title {
      font-size: 20px;
    }
    
    .code {
      font-size: 28px;
      letter-spacing: 6px;
    }
    
    .info-grid {
      grid-template-columns: 1fr;
    }
    
    .btn-primary {
      display: block;
      text-align: center;
    }
  }
`;

// =============================================
// GÉNÉRATEUR D'EN-TÊTE
// =============================================

const generateHeader = (type = 'general', title = '', brandColor = '#1a4a3a') => {
  const logoIcon = getLogoForEmail(type);
  
  const brandName = type === 'maman' ? 'Maman & Bébé' : 
                    type === 'aidant' ? 'Aidant' : 
                    'Santé Plus Services';
  
  return `
    <div class="header">
      <div class="logo-wrapper">
        <img src="${logoIcon}" alt="Santé Plus" class="logo-icon" />
        <span class="brand-name">${brandName}</span>
        <span class="brand-sub">Accompagnement & Coordination</span>
      </div>
      ${title ? `<h1 class="title">${title}</h1>` : ''}
    </div>
  `;
};

// =============================================
// GÉNÉRATEUR DE PIED DE PAGE
// =============================================

const generateFooter = () => `
  <div class="footer">
    <p class="footer-text">
      <strong>Santé Plus Services</strong><br>
      Cotonou, Bénin<br>
      📧 <a href="mailto:contact@santeplus.bj" style="color:#6b7280;text-decoration:none;">contact@santeplus.bj</a> 
      | 📞 <a href="tel:+2290191343458" style="color:#6b7280;text-decoration:none;">+229 01 91 34 34 58</a>
      <br>
      <a href="${SITE_URL}" style="color:#6b7280;text-decoration:none;font-size:12px;">🌐 ${SITE_URL.replace('https://', '')}</a>
    </p>
    <p class="footer-text" style="margin-top:8px; font-size:11px; color:#d1d5db;">
      © ${new Date().getFullYear()} Santé Plus Services — Tous droits réservés
    </p>
  </div>
`;

// =============================================
// TEMPLATES - AVEC URL VERCEL
// =============================================

const templates = {
  // =============================================
  // OTP - Code de vérification
  // =============================================
  otp: (otp, expiresIn = 10, type = 'general') => {
    const brandColor = type === 'maman' ? '#db4a6d' : type === 'aidant' ? '#2c6e5c' : '#1a4a3a';
    const secondaryColor = type === 'maman' ? '#f5d0d8' : type === 'aidant' ? '#b8d5cc' : '#c9a84c';
    const header = generateHeader(type, '🔐 Code de vérification', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    
    return {
      subject: '🔐 Code de vérification - Santé Plus Services',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Code de vérification</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Bonjour,</p>
              <p class="subtitle" style="margin-top: 6px;">
                Vous avez demandé à créer un compte administrateur pour <strong>Santé Plus Services</strong>.
              </p>
              <div class="highlight-box dashed">
                <div class="label">Votre code de vérification est :</div>
                <div class="code">${otp}</div>
                <div class="hint">⏱️ Ce code expire dans ${expiresIn} minutes</div>
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

  // =============================================
  // BIENVENUE
  // =============================================
  welcome: (name, type = 'general') => {
    const brandColor = type === 'maman' ? '#db4a6d' : type === 'aidant' ? '#2c6e5c' : '#1a4a3a';
    const secondaryColor = type === 'maman' ? '#f5d0d8' : type === 'aidant' ? '#b8d5cc' : '#c9a84c';
    const header = generateHeader(type, `Bienvenue ${name} 👋`, brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    const loginUrl = `${SITE_URL}/login`;
    
    return {
      subject: 'Bienvenue chez Santé Plus Services 🏥',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Bienvenue</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Nous sommes ravis de vous compter parmi nous.</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 12px;">
                Votre compte a été créé avec succès. Vous pouvez dès maintenant accéder à votre espace personnel.
              </p>
              <div style="text-align: center; margin: 24px 0;">
                <a href="${loginUrl}" class="btn-primary">Accéder à mon compte</a>
              </div>
              <div class="highlight-box" style="background:${brandColor}04;">
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

  // =============================================
  // AIDANT - APPROUVÉ
  // =============================================
  aidantApproved: (name) => {
    const brandColor = '#2c6e5c';
    const secondaryColor = '#b8d5cc';
    const header = generateHeader('aidant', '✅ Compte approuvé !', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    const loginUrl = `${SITE_URL}/login`;
    
    return {
      subject: '✅ Votre compte aidant est approuvé !',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Compte approuvé</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle" style="font-size:17px; font-weight:500;">Félicitations ${name} ! 🎉</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 8px;">
                Nous avons le plaisir de vous annoncer que votre compte aidant a été <strong>approuvé</strong>.
                Vous pouvez maintenant commencer à accepter des missions.
              </p>
              <div class="highlight-box" style="border-color:${brandColor};">
                <p style="font-weight:600; color:${brandColor}; margin-bottom:8px;">🚀 Ce que vous pouvez faire maintenant :</p>
                <ul class="feature-list">
                  <li>📋 Consulter les missions disponibles</li>
                  <li>✅ Accepter des missions</li>
                  <li>📊 Suivre votre historique</li>
                  <li>💬 Communiquer avec l'équipe</li>
                </ul>
              </div>
              <div style="text-align: center; margin: 20px 0;">
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

  // =============================================
  // AIDANT - REFUSÉ
  // =============================================
  aidantRejected: (name) => {
    const brandColor = '#6b7280';
    const secondaryColor = '#d1d5db';
    const header = generateHeader('aidant', 'Candidature - Information', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    
    return {
      subject: 'Candidature Santé Plus - Information',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Candidature</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Bonjour ${name},</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 8px;">
                Nous vous remercions pour l'intérêt que vous avez porté à <strong>Santé Plus Services</strong>.
              </p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7;">
                Après examen de votre candidature, nous ne pouvons pas donner suite à votre demande pour le moment.
              </p>
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

  // =============================================
  // MOT DE PASSE OUBLIÉ
  // =============================================
  forgotPassword: (name, resetLink, type = 'general') => {
    const brandColor = type === 'maman' ? '#db4a6d' : type === 'aidant' ? '#2c6e5c' : '#1a4a3a';
    const secondaryColor = type === 'maman' ? '#f5d0d8' : type === 'aidant' ? '#b8d5cc' : '#c9a84c';
    const header = generateHeader(type, '🔑 Réinitialisation', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    
    // ✅ Utiliser le lien de réinitialisation Vercel
    const resetUrl = resetLink || `${SITE_URL}/reset-password`;
    
    return {
      subject: 'Réinitialisation de votre mot de passe 🔑',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Réinitialisation</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Bonjour ${name},</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 8px;">
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

  // =============================================
  // INSCRIPTION VALIDÉE
  // =============================================
  registrationValidated: (data, type = 'general') => {
    const brandColor = type === 'maman' ? '#db4a6d' : type === 'aidant' ? '#2c6e5c' : '#1a4a3a';
    const secondaryColor = type === 'maman' ? '#f5d0d8' : type === 'aidant' ? '#b8d5cc' : '#c9a84c';
    const header = generateHeader(type, '✅ Inscription validée !', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    const loginUrl = `${SITE_URL}/login`;
    
    return {
      subject: '✅ Votre inscription est validée !',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Inscription validée</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Bonjour ${data.name || ''},</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 8px;">
                Nous avons le plaisir de vous informer que votre inscription a été <strong>validée</strong>.
                Vous pouvez dès maintenant accéder à tous nos services.
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

  // =============================================
  // RAPPEL DE VISITE
  // =============================================
  visitReminder: (data, type = 'general') => {
    const brandColor = type === 'maman' ? '#db4a6d' : type === 'aidant' ? '#2c6e5c' : '#1a4a3a';
    const secondaryColor = type === 'maman' ? '#f5d0d8' : type === 'aidant' ? '#b8d5cc' : '#c9a84c';
    const header = generateHeader(type, '📅 Rappel de visite', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    const visitsUrl = `${SITE_URL}/app/visits`;
    
    return {
      subject: 'Rappel : Visite prévue 📅',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Rappel de visite</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Bonjour,</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 8px;">
                Une visite est prévue pour <strong>${data.patient_name}</strong> le <strong>${data.date}</strong> à <strong>${data.time}</strong>.
              </p>
              <div class="highlight-box" style="border-color:${brandColor};">
                <div class="info-grid">
                  <div class="info-item">
                    <div class="label">📍 Adresse</div>
                    <div class="value">${data.address || 'Non précisée'}</div>
                  </div>
                  ${data.aidant_name ? `
                  <div class="info-item">
                    <div class="label">🧑‍⚕️ Aidant</div>
                    <div class="value">${data.aidant_name}</div>
                  </div>
                  ` : ''}
                </div>
              </div>
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

  // =============================================
  // PAIEMENT CONFIRMÉ
  // =============================================
  paymentConfirmed: (data, type = 'general') => {
    const brandColor = type === 'maman' ? '#db4a6d' : type === 'aidant' ? '#2c6e5c' : '#1a4a3a';
    const secondaryColor = type === 'maman' ? '#f5d0d8' : type === 'aidant' ? '#b8d5cc' : '#c9a84c';
    const header = generateHeader(type, '✅ Paiement confirmé', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    const billingUrl = `${SITE_URL}/app/billing`;
    
    return {
      subject: 'Paiement confirmé ✅',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Paiement confirmé</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Bonjour,</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 8px;">
                Nous vous confirmons la réception de votre paiement de <strong>${data.amount || '0'} FCFA</strong>.
              </p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7;">
                Votre abonnement <strong>${data.plan_name || 'Santé Plus'}</strong> est maintenant actif.
              </p>
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

  // =============================================
  // ABONNEMENT EXPIRE
  // =============================================
  subscriptionExpired: (data, type = 'general') => {
    const brandColor = type === 'maman' ? '#db4a6d' : type === 'aidant' ? '#2c6e5c' : '#1a4a3a';
    const secondaryColor = type === 'maman' ? '#f5d0d8' : type === 'aidant' ? '#b8d5cc' : '#c9a84c';
    const header = generateHeader(type, '⏰ Abonnement bientôt expiré', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    const billingUrl = `${SITE_URL}/app/billing`;
    
    return {
      subject: 'Votre abonnement arrive à expiration ⏰',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Abonnement expiration</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Bonjour,</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 8px;">
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

  // =============================================
  // VISITE APPROUVÉE
  // =============================================
  visitApproved: (data, type = 'general') => {
    const brandColor = type === 'maman' ? '#db4a6d' : type === 'aidant' ? '#2c6e5c' : '#1a4a3a';
    const secondaryColor = type === 'maman' ? '#f5d0d8' : type === 'aidant' ? '#b8d5cc' : '#c9a84c';
    const header = generateHeader(type, '✅ Visite acceptée', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    const visitsUrl = `${SITE_URL}/app/visits`;
    
    return {
      subject: '✅ Visite acceptée',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Visite acceptée</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Bonjour,</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 8px;">
                L'aidant a accepté la visite pour <strong>${data.patient_name}</strong> le <strong>${data.date}</strong> à <strong>${data.time}</strong>.
              </p>
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

  // =============================================
  // VISITE REFUSÉE
  // =============================================
  visitRefused: (data, type = 'general') => {
    const brandColor = '#dc2626';
    const secondaryColor = '#fca5a5';
    const header = generateHeader(type, '❌ Visite refusée', brandColor);
    const styles = getEmailStyles(brandColor, secondaryColor);
    
    return {
      subject: '❌ Visite refusée',
      htmlContent: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Visite refusée</title>
          <style>${styles}</style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              ${header}
              <p class="subtitle">Bonjour,</p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7; margin-top: 8px;">
                L'aidant a refusé la visite pour <strong>${data.patient_name}</strong> le <strong>${data.date}</strong>.
              </p>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.7;">
                Motif : <strong>${data.reason || 'Non précisé'}</strong>
              </p>
              <p style="color: #6b7280; font-size: 14px; margin-top: 12px;">
                Un nouvel aidant sera assigné prochainement.
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

module.exports = { sendEmail, templates };
