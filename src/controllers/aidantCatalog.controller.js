// 📁 backend/src/controllers/aidantCatalog.controller.js

const {
  getAvailableAidants,
  getAidantById,
  assignAidantToPatient,
  getFamilyAssignments,
  revokeAssignment,
} = require('../services/aidantCatalog.service');
const { asyncWrapper } = require('../utils/errorHandler');

// ============================================================
// RÉCUPÉRER LE CATALOGUE DES AIDANTS
// ============================================================
const getCatalog = asyncWrapper(async (req, res) => {
  try {
    const filters = {
      zone: req.query.zone,
      specialty: req.query.specialty,
      minRating: req.query.minRating ? parseFloat(req.query.minRating) : undefined,
      onlyAvailable: req.query.onlyAvailable !== 'false',
      minExperience: req.query.minExperience ? parseInt(req.query.minExperience) : undefined,
      sortBy: req.query.sortBy || 'rating',
      sortOrder: req.query.sortOrder || 'desc',
      limit: req.query.limit ? parseInt(req.query.limit) : 20,
      offset: req.query.offset ? parseInt(req.query.offset) : 0,
    };

    console.log('📋 Récupération du catalogue avec filtres:', filters);

    const aidants = await getAvailableAidants(filters);

    console.log(`✅ ${aidants.length} aidants récupérés`);
    res.json({
      success: true,
      data: aidants,
      count: aidants.length,
    });
  } catch (error) {
    console.error('❌ Erreur getCatalog:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des aidants',
    });
  }
});

// ============================================================
// RÉCUPÉRER UN AIDANT PAR ID
// ============================================================
const getAidant = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📋 Récupération de l\'aidant:', id);

    const aidant = await getAidantById(id);

    if (!aidant) {
      return res.status(404).json({
        success: false,
        error: 'Aidant non trouvé',
      });
    }

    res.json({
      success: true,
      data: aidant,
    });
  } catch (error) {
    console.error('❌ Erreur getAidant:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération de l\'aidant',
    });
  }
});

// ============================================================
// RÉCUPÉRER LES ASSIGNATIONS DE LA FAMILLE
// ============================================================
const getMyAssignments = asyncWrapper(async (req, res) => {
  try {
    const familyId = req.user.id;
    console.log('📋 Récupération des assignations pour la famille:', familyId);

    const assignments = await getFamilyAssignments(familyId);

    console.log(`✅ ${assignments.length} assignations récupérées`);
    res.json({
      success: true,
      data: assignments,
    });
  } catch (error) {
    console.error('❌ Erreur getMyAssignments:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des assignations',
    });
  }
});

// ============================================================
// ASSIGNER UN AIDANT - AVEC patientId OPTIONNEL
// ============================================================
const assignAidant = asyncWrapper(async (req, res) => {
  try {
    const { aidantId, patientId, assignmentType = 'permanente' } = req.body;
    const familyId = req.user.id;

    console.log('📤 Assignation aidant - Payload reçu:', { aidantId, patientId, assignmentType, familyId });

    // ✅ Validation : aidantId est obligatoire
    if (!aidantId) {
      return res.status(400).json({
        success: false,
        error: 'aidantId est requis',
      });
    }

    // ✅ patientId est optionnel - peut être null ou undefined
    const result = await assignAidantToPatient(
      aidantId,
      familyId,
      patientId || null,   // ✅ null autorisé
      assignmentType
    );

    console.log('✅ Aidant assigné avec succès:', result);

    res.status(201).json({
      success: true,
      message: 'Aidant assigné avec succès',
      data: result,
    });
  } catch (error) {
    console.error('❌ Erreur assignAidant:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de l\'assignation',
    });
  }
});

// ============================================================
// RÉVOQUER UNE ASSIGNATION - AVEC NOTIFICATIONS COMPLÈTES
// ============================================================
const revokeAssignmentController = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    const familyId = req.user.id;

    console.log('📤 Révocation assignation:', id, 'pour la famille:', familyId);

    const result = await revokeAssignment(id, familyId);

    res.json({
      success: true,
      message: 'Assignation révoquée avec succès',
      data: result,
    });
  } catch (error) {
    console.error('❌ Erreur revokeAssignment:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la révocation',
    });
  }
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getCatalog,                      // ✅ Définie
  getAidant,                       // ✅ Définie
  assignAidant,                    // ✅ Définie
  getMyAssignments,                // ✅ Définie
  revokeAssignmentController,      // ✅ Définie
};
