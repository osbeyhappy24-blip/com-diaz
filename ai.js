import fs from 'fs';

function leerEnv() {
  if (process.env.GEMINI_API_KEY) return;
  try {
    const txt = fs.readFileSync(new URL('./.env', import.meta.url), 'utf8');
    for (const l of txt.split('\n')) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

export async function preguntarIA(prompt, { json = false } = {}) {
  leerEnv();
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!key || !model) throw new Error('Falta GEMINI_API_KEY o GEMINI_MODEL');
  for (let intento = 1; intento <= 4; intento++) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: json ? { responseMimeType: 'application/json' } : {},
      }),
    });
    if (r.status === 429 || r.status >= 500) {
      await new Promise(s => setTimeout(s, 6000 * intento));
      continue;
    }
    const d = await r.json();
    if (!r.ok) throw new Error((d && d.error && d.error.message) || ('HTTP ' + r.status));
    const partes = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    return partes.map(p => p.text || '').join('');
  }
  throw new Error('IA ocupada (límite gratuito). Intenta en unos minutos.');
}
