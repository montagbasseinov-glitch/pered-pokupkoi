const Busboy = require('busboy');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Метод не поддерживается' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Не настроен ключ AI. Добавьте OPENAI_API_KEY в Vercel.' });

  try {
    const { file, mimeType, fileName, category } = await parseUpload(req);
    if (!file) return res.status(400).json({ error: 'Файл не получен' });
    if (file.length > 7 * 1024 * 1024) return res.status(413).json({ error: 'Файл слишком большой. Максимум 7 МБ.' });

    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob([file], { type: mimeType || 'application/octet-stream' }), fileName || 'document');
    const upload = await fetch('https://api.openai.com/v1/files', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form
    });
    if (!upload.ok) throw new Error(`OpenAI file upload: ${await upload.text()}`);
    const uploaded = await upload.json();

    const isImage = (mimeType || '').startsWith('image/');
    const content = isImage
      ? [{ type: 'input_text', text: makePrompt(category) }, { type: 'input_image', file_id: uploaded.id }]
      : [{ type: 'input_text', text: makePrompt(category) }, { type: 'input_file', file_id: uploaded.id }];

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [{ role: 'user', content }] })
    });
    if (!response.ok) throw new Error(`OpenAI response: ${await response.text()}`);
    const data = await response.json();
    const text = data.output_text || extractText(data);
    return res.status(200).json({ result: text || 'Не удалось получить результат анализа.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Не удалось выполнить проверку. Попробуйте ещё раз.' });
  }
};

function makePrompt(category) {
  return `Ты — аналитик сервиса «Перед покупкой». Пользователь собирается что-то купить или заказать. Категория: ${category || 'не указана'}.
Проанализируй загруженный материал максимально практично. Не утверждай, что продавец обманывает, если это не доказано. Отделяй факты от предположений.
Ответ на русском языке, структурированно:
1. Кратко: что это и что предлагается.
2. Оценка риска от 1 до 10 с объяснением.
3. Что настораживает — конкретные пункты.
4. Чего не хватает для безопасного решения.
5. 5–10 вопросов, которые нужно задать продавцу/исполнителю.
6. Что проверить до оплаты.
7. Возможные дополнительные расходы или обязательства.
8. Итог: стоит ли переходить к следующему шагу сейчас или сначала запросить уточнения.
Не выдумывай цены, факты или сведения, которых нет в материале.`;
}

function extractText(data) {
  const out = [];
  for (const item of data.output || []) for (const c of item.content || []) if (c.type === 'output_text') out.push(c.text);
  return out.join('\n');
}

function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 7 * 1024 * 1024 } });
    let chunks = [], info = null, category = '';
    bb.on('field', (name, val) => { if (name === 'category') category = val; });
    bb.on('file', (name, stream, fileInfo) => {
      info = fileInfo;
      stream.on('data', d => chunks.push(d));
      stream.on('limit', () => reject(new Error('FILE_TOO_LARGE')));
    });
    bb.on('finish', () => resolve({ file: Buffer.concat(chunks), mimeType: info?.mimeType, fileName: info?.filename, category }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}
