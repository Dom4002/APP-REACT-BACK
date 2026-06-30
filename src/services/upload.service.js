// 📁 backend/src/services/upload.service.js

const { supabase } = require('./supabase.service');
const { v4: uuidv4 } = require('uuid');

// =============================================
// UPLOAD PHOTO DE VISITE
// =============================================
const uploadVisitPhoto = async (file, visiteId, userId) => {
  try {
    const fileExt = file.originalname.split('.').pop();
    const fileName = `${visiteId}/${uuidv4()}.${fileExt}`;
    
    const { data, error } = await supabase.storage
      .from('visites')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from('visites')
      .getPublicUrl(data.path);

    // ✅ Enregistrer en base
    await supabase
      .from('visite_photos')
      .insert({
        visite_id: visiteId,
        photo_url: publicUrl,
        uploaded_by: userId,
      });

    return publicUrl;
  } catch (error) {
    console.error('Upload visit photo error:', error);
    throw error;
  }
};

// =============================================
// UPLOAD AUDIO DE VISITE
// =============================================
const uploadVisitAudio = async (file, visiteId, userId) => {
  try {
    const fileExt = file.originalname.split('.').pop();
    const fileName = `${visiteId}/${uuidv4()}.${fileExt}`;
    
    const { data, error } = await supabase.storage
      .from('audios')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from('audios')
      .getPublicUrl(data.path);

    // ✅ Enregistrer en base
    await supabase
      .from('visite_audios')
      .insert({
        visite_id: visiteId,
        audio_url: publicUrl,
        uploaded_by: userId,
      });

    return publicUrl;
  } catch (error) {
    console.error('Upload visit audio error:', error);
    throw error;
  }
};

// =============================================
// UPLOAD MULTIPLE PHOTOS
// =============================================
const uploadMultipleVisitPhotos = async (files, visiteId, userId) => {
  const urls = [];
  for (const file of files) {
    const url = await uploadVisitPhoto(file, visiteId, userId);
    urls.push(url);
  }
  return urls;
};

// =============================================
// SUPPRIMER UN FICHIER
// =============================================
const deleteFile = async (bucket, path) => {
  try {
    const { error } = await supabase.storage
      .from(bucket)
      .remove([path]);
    
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Delete file error:', error);
    throw error;
  }
};

module.exports = {
  uploadVisitPhoto,
  uploadVisitAudio,
  uploadMultipleVisitPhotos,
  deleteFile,
};