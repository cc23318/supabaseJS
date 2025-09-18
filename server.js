require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Configure o multer para usar a pasta tmp do Render
const upload = multer({ 
  dest: process.env.NODE_ENV === 'production' ? '/tmp/uploads' : 'uploads/'
});

const port = process.env.PORT || 3000;

// Configuração do Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Middlewares
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'DELETE', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check para o Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Rota de teste
app.get('/conexao', (req, res) => {
  res.status(200).json({ status: 'Conexão estabelecida com sucesso!' });
});

// Rota para listar imagens com análise e localização
app.get('/images', async (req, res) => {
  try {
    console.log('Buscando imagens no banco de dados...');
    
    const { data: images, error } = await supabase
      .from('images')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    console.log(`Encontradas ${images.length} imagens no banco de dados`);

    const imagesWithUrls = await Promise.all(images.map(async (image) => {
      console.log(`Processando imagem ${image.id} - ${image.url}`);
      
      // Verifica se a URL já é uma URL pública (começa com http)
      if (image.url.startsWith('http')) {
        console.log(`Imagem ${image.id} já tem URL pública: ${image.url}`);
        return {
          id: image.id,
          url: image.url,
          user_id: image.user_id,
          created_at: image.created_at,
          latitude: image.latitude || null,
          longitude: image.longitude || null,
          analysis: image.analysis || null
        };
      }

      // Se não for URL pública, gera URL a partir do caminho do arquivo
      console.log(`Gerando URL assinada para: ${image.url}`);
      const { data: signedUrl, error: urlError } = await supabase
        .storage
        .from('imagens')
        .createSignedUrl(image.url, 3600); // 1 hora

      if (urlError) {
        console.error(`Erro ao gerar URL para imagem ${image.id}:`, urlError);
        // Tenta criar uma URL pública alternativa
        const { data: publicUrlData } = supabase.storage
          .from('imagens')
          .getPublicUrl(image.url);
        
        return {
          id: image.id,
          url: publicUrlData.publicUrl,
          user_id: image.user_id,
          created_at: image.created_at,
          latitude: image.latitude || null,
          longitude: image.longitude || null,
          analysis: image.analysis || null
        };
      }

      return {
        id: image.id,
        url: signedUrl.signedUrl,
        user_id: image.user_id,
        created_at: image.created_at,
        latitude: image.latitude || null,
        longitude: image.longitude || null,
        analysis: image.analysis || null
      };
    }));

    console.log('Imagens processadas com sucesso');
    res.status(200).json(imagesWithUrls);

  } catch (error) {
    console.error('Erro ao buscar imagens:', error);
    res.status(500).json({ 
      error: 'Erro ao buscar imagens',
      details: error.message 
    });
  }
});

// Rota de upload com análise e localização
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const { user_id, latitude, longitude, analysis } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada' });
    }

    if (!user_id) {
      return res.status(400).json({ error: 'user_id é obrigatório' });
    }

    // Lê o arquivo como buffer
    const fileBuffer = fs.readFileSync(req.file.path);
    
    // Nome único para imagem
    const fileName = `${Date.now()}_${req.file.originalname || 'image.jpg'}`;
    const filePath = `images/${fileName}`;

    // Upload para bucket 'imagens'
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('imagens')
      .upload(filePath, fileBuffer, {
        cacheControl: '3600',
        upsert: false,
        contentType: req.file.mimetype
      });

    if (uploadError) {
      throw uploadError;
    }

    // URL pública da imagem
    const { data: publicUrlData } = supabase.storage
      .from('imagens')
      .getPublicUrl(filePath);

    console.log('URL pública gerada:', publicUrlData.publicUrl);

    // Salva na tabela images
    const { data: insertData, error: insertError } = await supabase
      .from('images')
      .insert([{
        user_id,
        url: filePath, // caminho do arquivo
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        analysis: analysis || null,
        created_at: new Date().toISOString()
      }])
      .select();

    if (insertError) throw insertError;

    // Remove arquivo temporário
    fs.unlinkSync(req.file.path);

    return res.status(200).json({
      message: 'Upload realizado com sucesso!',
      imageId: insertData[0].id,
      imageUrl: publicUrlData.publicUrl,
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      analysis: analysis || null
    });

  } catch (error) {
    console.error('Erro no upload:', error);
    
    // Limpa arquivo temporário em caso de erro
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    return res.status(500).json({
      error: 'Erro ao fazer upload da imagem',
      details: error.message
    });
  }
});

// Rota para deletar imagem
app.delete('/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`Iniciando exclusão da imagem ${id}`);

    // Busca a imagem no banco para pegar o caminho do arquivo
    const { data: image, error: fetchError } = await supabase
      .from('images')
      .select('url')
      .eq('id', id)
      .single();

    if (fetchError || !image) {
      return res.status(404).json({ error: 'Imagem não encontrada' });
    }

    console.log(`Deletando arquivo do storage: ${image.url}`);

    // Remove do storage
    const { error: deleteStorageError } = await supabase
      .storage
      .from('imagens')
      .remove([image.url]);

    if (deleteStorageError) {
      console.error('Erro ao deletar do storage:', deleteStorageError);
    }

    // Remove do banco de dados
    const { error: deleteDbError } = await supabase
      .from('images')
      .delete()
      .eq('id', id);

    if (deleteDbError) throw deleteDbError;

    // Remove da tabela metadata também
    try {
      const { error: deleteMetadataError } = await supabase
        .from('images_metadata')
        .delete()
        .eq('file_path', image.url);

      if (deleteMetadataError) {
        console.warn('Erro ao deletar metadata:', deleteMetadataError);
      }
    } catch (metadataError) {
      console.warn('Erro ao deletar metadata:', metadataError);
    }

    console.log(`Imagem ${id} excluída com sucesso`);
    res.status(200).json({ success: true });

  } catch (error) {
    console.error('Erro ao excluir imagem:', error);
    res.status(500).json({ 
      error: 'Erro ao excluir imagem',
      details: error.message 
    });
  }
});

// rotas de foto de perfil

// Upload de imagem de perfil 
app.post('/upload-profile', upload.single('image'), async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada' });
    }

    if (!user_id) {
      return res.status(400).json({ error: 'user_id é obrigatório' });
    }

    // Lê o arquivo como buffer
    const fileBuffer = fs.readFileSync(req.file.path);
    
    // Nome único 
    const fileName = `profile_${user_id}.jpg`;
    const filePath = fileName;

    // Upload para bucket profiles
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('profiles')
      .upload(filePath, fileBuffer, {
        cacheControl: '3600',
        upsert: true,
        contentType: req.file.mimetype
      });

    if (uploadError) {
      throw uploadError;
    }

    // URL pública da imagem
    const { data: publicUrlData } = supabase.storage
      .from('profiles')
      .getPublicUrl(filePath);

    console.log('URL pública da imagem de perfil:', publicUrlData.publicUrl);
    
    const { data: existingUser, error: findError } = await supabase
      .from('users')
      .select('id')
      .eq('firebase_id', user_id)
      .single();

    if (findError && findError.code !== 'PGRST116') { // não encontrado
      throw findError;
    }

    if (existingUser) {
      const { data: updateData, error: updateError } = await supabase
        .from('users')
        .update({ 
          profile_image_url: publicUrlData.publicUrl
        })
        .eq('firebase_id', user_id)
        .select();

      if (updateError) throw updateError;
    } else {
      const { data: insertData, error: insertError } = await supabase
        .from('users')
        .insert([{
          firebase_id: user_id,
          profile_image_url: publicUrlData.publicUrl,
          created_at: new Date().toISOString()
        }])
        .select();

      if (insertError) throw insertError;
    }

    // Remove arquivo temporário
    fs.unlinkSync(req.file.path);

    return res.status(200).json({
      message: 'Imagem de perfil atualizada com sucesso!',
      profileImageUrl: publicUrlData.publicUrl
    });

  } catch (error) {
    console.error('Erro no upload de perfil:', error);
    
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    return res.status(500).json({
      error: 'Erro ao fazer upload da imagem de perfil',
      details: error.message
    });
  }
});

// Buscar URL da imagem de perfil
app.get('/profile-image/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const { data: user, error } = await supabase
      .from('users')
      .select('profile_image_url')
      .eq('firebase_id', user_id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') { // Não encontrado
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      throw error;
    }

    if (!user.profile_image_url) {
      return res.status(404).json({ error: 'Imagem de perfil não encontrada' });
    }

    // Se já é URL completa, retorna diretamente
    if (user.profile_image_url.startsWith('http')) {
      return res.status(200).json({ profileImageUrl: user.profile_image_url });
    }

    // Se for caminho de arquivo, gera URL
    const { data: publicUrlData } = supabase.storage
      .from('profiles')
      .getPublicUrl(user.profile_image_url);
    
    return res.status(200).json({ profileImageUrl: publicUrlData.publicUrl });

  } catch (error) {
    console.error('Erro ao buscar imagem de perfil:', error);
    res.status(500).json({ 
      error: 'Erro ao buscar imagem de perfil',
      details: error.message 
    });
  }
});

// Inicia o servidor (modificado para Render)
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Teste as rotas:`);
  console.log(`- GET  https://supabasejs.onrender.com/health`);
  console.log(`- GET  https://supabasejs.onrender.com/conexao`);
  console.log(`- GET  https://supabasejs.onrender.com/images`);
  console.log(`- POST https://supabasejs.onrender.com/upload`);
  console.log(`- DELETE https://supabasejs.onrender.com/images/:id`);
}); 