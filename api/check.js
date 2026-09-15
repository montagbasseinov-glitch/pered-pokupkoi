const Busboy = require('busboy');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Метод не поддерживается' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Не настроен ключ AI. Добавьте OPENAI_API_KEY в Vercel.' });

  try {
    const { file, mimeType, fileName, category, url, question } = await parseUpload(req);
    if (file && file.length > 7 * 1024 * 1024) return res.status(413).json({ error: 'Файл слишком большой. Максимум 7 МБ.' });

    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Ссылка выглядит некорректно.' }); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Нужна обычная веб-ссылка http или https.' });
      return await analyzeUrl(req, res, url, category, question);
    }

    if (!file) return res.status(400).json({ error: 'Ссылка или файл не получены.' });

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
      ? [{ type: 'input_text', text: makePrompt(category, question) }, { type: 'input_image', file_id: uploaded.id }]
      : [{ type: 'input_text', text: makePrompt(category, question) }, { type: 'input_file', file_id: uploaded.id }];

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

async function analyzeUrl(req, res, url, category, question) {
  const prompt = `Ты — аналитик сервиса «Перед покупкой». Пользователь хочет купить объект по объявлению.
КАТЕГОРИЯ: ${category || 'не указана'}
ССЫЛКА НА ОБЪЯВЛЕНИЕ: ${url}
${question ? `ОСОБЫЙ ВОПРОС ПОЛЬЗОВАТЕЛЯ: ${question}` : ''}

Открой именно указанную ссылку и изучи доступное содержимое объявления. Если страница не открывается или данных недостаточно, прямо скажи об этом и не выдумывай сведения.
Если на странице есть цена, характеристики, описание, продавец, фотографии, даты, пробег, площадь, комплектация или другие данные — используй только реально доступные сведения.
Отделяй факты объявления от своих предположений. Не утверждай мошенничество или неисправность без доказательств.

Ответ на русском языке, структурированно:
1. ЧТО ПРОДАЮТ — краткое резюме объявления.
2. РИСК — оценка от 1 до 10 с объяснением.
3. ЧТО НАСТОРАЖИВАЕТ — конкретные признаки и несоответствия.
4. ЧЕГО НЕ ХВАТАЕТ — какие сведения нужно получить у продавца.
5. ЧТО СПРОСИТЬ — 7–10 конкретных вопросов продавцу.
6. ЧТО ПРОВЕРИТЬ ДО ОПЛАТЫ — пошаговый список.
7. ВОЗМОЖНЫЕ ДОПРАСХОДЫ — только обоснованные объявлением или типом покупки.
8. ИТОГ — можно ли двигаться дальше, что сделать перед встречей/авансом/оплатой.

Если веб-страница недоступна, не подменяй её содержимое общими догадками: сообщи, что именно не удалось проверить, и предложи пользователю загрузить скриншоты объявления.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      tools: [{ type: 'web_search' }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
    })
  });
  if (!response.ok) throw new Error(`OpenAI web search response: ${await response.text()}`);
  const data = await response.json();
  const text = data.output_text || extractText(data);
  return res.status(200).json({ result: text || 'Не удалось получить результат анализа объявления.' });
}

function makePrompt(category, question) {
  return `Ты — аналитик сервиса «Перед покупкой». Пользователь собирается что-то купить или заказать. Категория: ${category || 'не указана'}.
${question ? `Особый вопрос пользователя: ${question}` : ''}
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
    let chunks = [], info = null, category = '', url = '', question = '';
    bb.on('field', (name, val) => {
      if (name === 'category') category = val;
      if (name === 'url') url = val.trim();
      if (name === 'question') question = val.trim();
    });
    bb.on('file', (name, stream, fileInfo) => {
      info = fileInfo;
      stream.on('data', d => chunks.push(d));
      stream.on('limit', () => reject(new Error('FILE_TOO_LARGE')));
    });
    bb.on('finish', () => resolve({ file: chunks.length ? Buffer.concat(chunks) : null, mimeType: info?.mimeType, fileName: info?.filename, category, url, question }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}
