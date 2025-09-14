// conectar.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  const { data, error } = await supabase.from('usuarios').select('*');
  if (error) {
    console.error('Erro ao conectar:', error.message);
  } else {
    console.log('Dados:', data);
  }
})();