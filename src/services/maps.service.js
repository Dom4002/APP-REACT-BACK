// 📁 backend/src/services/maps.service.js
const { Client } = require("@googlemaps/google-maps-services-js");

const client = new Client({});

/**
 * Convertit une adresse textuelle en coordonnées GPS
 */
const getCoordinatesFromAddress = async (address) => {
  if (!address) return null;
  
  try {
    const response = await client.geocode({
      params: {
        address: address,
        key: process.env.GOOGLE_MAPS_API_KEY,  
      },
    });

    if (response.data.results.length > 0) {
      const { lat, lng } = response.data.results[0].geometry.location;
      return { lat, lng };
    }
    return null;
  } catch (error) {
    console.error("❌ Erreur Géocodage Google Maps:", error.response?.data?.error_message || error.message);
    return null;
  }
};

module.exports = { getCoordinatesFromAddress };
