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
      patientId || null,  // ✅ null autorisé
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
// EXPORTS
// ============================================================
module.exports = {
  getCatalog,
  getAidant,
  assignAidant,
  getMyAssignments,
  revokeAssignmentController: revokeAssignment,
};
