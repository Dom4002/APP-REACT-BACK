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
// ASSIGNER UN AIDANT
// ============================================================
const assignAidant = asyncWrapper(async (req, res) => {
  const { aidantId, patientId, assignmentType = 'permanente' } = req.body;
  const familyId = req.user.id;

  if (!aidantId || !patientId) {
    return res.status(400).json({
      success: false,
      error: 'aidantId et patientId sont requis',
    });
  }

  const result = await assignAidantToPatient(
    aidantId,
    familyId,
    patientId,
    assignmentType
  );

  res.status(201).json({
    success: true,
    message: 'Aidant assigné avec succès',
    data: result,
  });
});

// ============================================================
// RÉCUPÉRER LES ASSIGNATIONS DE LA FAMILLE
// ============================================================
const getMyAssignments = asyncWrapper(async (req, res) => {
  const familyId = req.user.id;
  const assignments = await getFamilyAssignments(familyId);

  res.json({
    success: true,
    data: assignments,
  });
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
