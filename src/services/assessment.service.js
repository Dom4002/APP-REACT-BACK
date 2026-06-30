// 📁 backend/src/services/assessment.service.js

const { supabase } = require('./supabase.service');

const createAssessment = async (data) => {
  try {
    const { data: assessment, error } = await supabase
      .from('assessments')
      .insert({
        user_id: data.userId,
        patient_id: data.patientId || null,
        category: data.category, // 'senior' | 'maman_bebe'
        responses: data.responses,
        score: data.score || 0,
        recommendations: data.recommendations || [],
        status: 'pending',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return assessment;
  } catch (error) {
    console.error('Create assessment error:', error);
    throw error;
  }
};

const getAssessment = async (id) => {
  try {
    const { data, error } = await supabase
      .from('assessments')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Get assessment error:', error);
    throw error;
  }
};

const getAssessmentsByUser = async (userId) => {
  try {
    const { data, error } = await supabase
      .from('assessments')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Get assessments by user error:', error);
    throw error;
  }
};

module.exports = { createAssessment, getAssessment, getAssessmentsByUser };