// 📁 backend/src/routes/assessment.routes.js

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { createAssessment, getAssessment, getAssessmentsByUser } = require('../services/assessment.service');

router.use(authMiddleware);

// Créer une évaluation
router.post('/', async (req, res) => {
  try {
    const assessment = await createAssessment({
      userId: req.user.id,
      ...req.body,
    });
    res.status(201).json({ success: true, assessment });
  } catch (error) {
    console.error('Create assessment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer une évaluation
router.get('/:id', async (req, res) => {
  try {
    const assessment = await getAssessment(req.params.id);
    res.json(assessment);
  } catch (error) {
    console.error('Get assessment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer les évaluations d'un utilisateur
router.get('/user/:userId', async (req, res) => {
  try {
    const assessments = await getAssessmentsByUser(req.params.userId);
    res.json(assessments);
  } catch (error) {
    console.error('Get user assessments error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;