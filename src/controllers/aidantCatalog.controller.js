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
// RÉCUPÉRER LES AIDANTS DISPONIBLES
// ============================================================
const getCatalog = asyncWrapper(async (req, res) => {
  const {
    zone,
    specialty,
    minRating,
    onlyAvailable = 'true',
    minExperience,
    sortBy = 'rating',
    sortOrder = 'desc',
    limit = 20,
    offset = 0,
  } = req.query;

  const aidants = await getAvailableAidants({
    zone,
    specialty,
    minRating: minRating ? parseFloat(minRating) : undefined,
    onlyAvailable: onlyAvailable === 'true',
    minExperience: minExperience ? parseInt(minExperience) : undefined,
    sortBy,
    sortOrder,
    limit: parseInt(limit),
    offset: parseInt(offset),
  });

  res.json({
    success: true,
    data: aidants,
    count: aidants.length,
    filters: { zone, specialty, minRating, onlyAvailable, sortBy, sortOrder },
  });
});

// ============================================================
// RÉCUPÉRER UN AIDANT PAR ID
// ============================================================
const getAidant = asyncWrapper(async (req, res) => {
  const { id } = req.params;
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
});

// ============================================================
// ✅ ASSIGNER UN AIDANT - CORRIGÉ (patientId OPTIONNEL)
// ============================================================
const assignAidant = asyncWrapper(async (req, res) => {
  const { aidantId, patientId, assignmentType = 'permanente' } = req.body;
  const familyId = req.user.id;

  // ✅ Seul aidantId est requis - patientId est OPTIONNEL
  if (!aidantId) {
    return res.status(400).json({
      success: false,
      error: 'aidantId est requis',
    });
  }

  console.log('📤 Assignation aidant:', {
    aidantId,
    patientId: patientId || null,
    familyId,
    assignmentType,
  });

  try {
    // ✅ patientId peut être null (assignation personnelle)
    const result = await assignAidantToPatient(
      aidantId,
      familyId,
      patientId || null,  // ✅ null autorisé
      assignmentType
    );

    res.status(201).json({
      success: true,
      message: patientId 
        ? 'Aidant assigné au patient avec succès'
        : 'Aidant assigné à votre compte personnel avec succès',
      data: result,
    });
  } catch (error) {
    console.error('❌ Erreur assignation:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de l\'assignation',
    });
  }
});

// ============================================================
// RÉCUPÉRER LES ASSIGNATIONS DE LA FAMILLE
// ============================================================
const getMyAssignments = asyncWrapper(async (req, res) => {
  const familyId = req.user.id;
  
  console.log('📤 Récupération assignations pour:', familyId);

  try {
    const assignments = await getFamilyAssignments(familyId);

    res.json({
      success: true,
      data: assignments || [],
    });
  } catch (error) {
    console.error('❌ Erreur récupération assignations:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des assignations',
    });
  }
});

// ============================================================
// RÉVOQUER UNE ASSIGNATION
// ============================================================
const revokeAssignmentController = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const familyId = req.user.id;

  const result = await revokeAssignment(id, familyId);

  res.json({
    success: true,
    message: 'Assignation révoquée avec succès',
    data: result,
  });
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getCatalog,
  getAidant,
  assignAidant,
  getMyAssignments,
  revokeAssignmentController,
};
