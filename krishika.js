/* KRISHIKA PDF → form data
 * The KRISHIKA PDF has no text layer (text is drawn as shapes), so pages are rendered
 * with pdf.js and read with Tesseract OCR — all inside the browser, nothing is uploaded.
 * Exposes window.Krishika.read(file, onProgress) → Promise<data>
 */
(function () {
  'use strict';

  const abs = p => new URL(p, document.baseURI).href;
  const PAGES = 3;      // details we need are on pages 1–3
  const SCALE = 2.5;    // ≈180 dpi — enough for clean OCR

  // ---------- library loading (on demand) ----------
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = res; s.onerror = () => rej(new Error('load failed: ' + src));
      document.head.append(s);
    });
  }
  let libsP = null;
  function loadLibs() {
    if (!libsP) {
      libsP = Promise.all([loadScript('pdf.min.js'), loadScript('tesseract.min.js')])
        .then(() => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = abs('pdf.worker.min.js'); })
        .catch(e => { libsP = null; throw e; });
    }
    return libsP;
  }

  async function renderPages(file) {
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = [];
    for (let i = 1; i <= Math.min(PAGES, pdf.numPages); i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: SCALE });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push(c);
    }
    pdf.destroy();
    return out;
  }

  async function ocrPages(canvases, onProgress) {
    let pageNo = 0;
    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: abs('worker.min.js'),
      corePath: abs('./'),
      langPath: abs('./'),
      logger: m => {
        if (m.status === 'recognizing text') onProgress(0.25 + 0.75 * ((pageNo + m.progress) / canvases.length));
        else if (m.status && m.status.startsWith('load')) onProgress(0.05 + 0.2 * (m.progress || 0));
      }
    });
    const pages = [];
    try {
      for (; pageNo < canvases.length; pageNo++) {
        const { data } = await worker.recognize(canvases[pageNo]);
        pages.push({ text: data.text, words: data.words, lines: data.lines, W: canvases[pageNo].width });
      }
    } finally { await worker.terminate(); }
    return pages;
  }

  // ---------- page 1: "Label" with value underneath ----------
  const norm = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');

  function findLabel(words, label) {
    const toks = label.split(/\s+/).map(norm);
    for (let i = 0; i + toks.length <= words.length; i++) {
      let ok = true;
      for (let j = 0; j < toks.length; j++) {
        if (norm(words[i + j].text) !== toks[j]) { ok = false; break; }
      }
      if (ok) {
        const a = words[i].bbox, b = words[i + toks.length - 1].bbox;
        return { x0: a.x0, x1: b.x1, y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) };
      }
    }
    return null;
  }

  const LABELS = ['Farmer Name', 'Mobile', 'Aadhar Number', 'DOB', 'Gender', 'Farmer Category', 'Farmer Type',
    'Social Category', 'Relative Type', 'Relative Name', 'Primary Occupation', 'State', 'District',
    'Block/Subdistrict', 'Village', 'Pincode', 'Address'];
  const FULL_WIDTH = ['Farmer Name', 'Address'];

  function readFields(page) {
    const words = page.words.filter(w => w.text.trim());
    const pos = {};
    LABELS.forEach(l => { const p = findLabel(words, l); if (p) pos[l] = p; });
    const out = {};
    Object.entries(pos).forEach(([label, p]) => {
      const lh = p.y1 - p.y0;
      let right = Infinity;
      if (!FULL_WIDTH.includes(label)) {
        Object.values(pos).forEach(q => {
          if (q !== p && Math.abs(q.y0 - p.y0) < lh && q.x0 > p.x0 + 10) right = Math.min(right, q.x0);
        });
        if (right === Infinity && p.x0 < page.W * 0.3) right = page.W * 0.36; // fallback: left column
      }
      const cand = words.filter(w => w.bbox.y0 > p.y1 - 3 && w.bbox.y0 < p.y1 + lh * 2.6 &&
        w.bbox.x0 >= p.x0 - page.W * 0.02 && w.bbox.x0 < right - 5);
      if (!cand.length) return;
      const top = Math.min(...cand.map(w => w.bbox.y0));
      out[label] = cand.filter(w => Math.abs(w.bbox.y0 - top) < lh * 0.7)
        .sort((a, b) => a.bbox.x0 - b.bbox.x0).map(w => w.text).join(' ').trim();
    });
    return out;
  }

  // ---------- page 2: land record rows "… Village  Survey  Khata  2.36 ha" ----------
  function readLands(text) {
    const lands = [], seen = new Set();
    const sec = text.split(/Land\s*Record\s*Details/i)[1] || text;
    sec.split('\n').forEach(line => {
      const m = line.match(/^(.*?)\s+([0-9][0-9A-Za-z\/\-]*)\s+([0-9]+)\s+([0-9]+(?:\.[0-9]+)?)\s*ha\b/i);
      if (!m) return;
      const before = m[1].split(/maharashtra/i).pop().replace(/[^A-Za-z()\s-]/g, ' ').replace(/\s+/g, ' ').trim();
      if (seen.has(m[2])) return;
      seen.add(m[2]);
      lands.push({ village: before, survey: m[2], khata: m[3], area: m[4] });
    });
    return lands;
  }

  // ---------- crops & season (Activity Details) ----------
  const CROP_MAP = [
    [/cotton|kapaas|kapas/i, 'कापूस'], [/soya\s*bean|soybean/i, 'सोयाबीन'], [/\btur\b|arhar|pigeon/i, 'तूर'],
    [/wheat/i, 'गहू'], [/jowar|sorghum/i, 'ज्वारी'], [/bajra|pearl\s*millet/i, 'बाजरी'],
    [/gram|chana|harbhara/i, 'हरभरा'], [/sugar\s*cane|sugarcane/i, 'ऊस'], [/maize|corn/i, 'मका'],
    [/onion/i, 'कांदा'], [/moong|green\s*gram/i, 'मूग'], [/urad|udid|black\s*gram/i, 'उडीद']
  ];
  function readCrops(text) {
    const sec = text.split(/Activity\s*Details/i)[1] || '';
    const zone = sec.split(/Loan\s*Eligibility/i)[0] || sec;
    const crops = [];
    CROP_MAP.forEach(([re, mr]) => { if (re.test(zone) && !crops.includes(mr)) crops.push(mr); });
    const season = /\brabi\b/i.test(zone) && !/\bkharif\b/i.test(zone) ? 'r' : (/\bkharif\b/i.test(zone) ? 'k' : '');
    return { crops, season };
  }

  // ---------- English → Marathi (names) ----------
  // Common names/surnames/places spelled the usual Marathi way; everything else goes through phonetic rules.
  const DICT = {
    // men
    ram: 'राम', shyam: 'श्याम', ganesh: 'गणेश', suresh: 'सुरेश', ramesh: 'रमेश', mahesh: 'महेश', dinesh: 'दिनेश',
    rajesh: 'राजेश', santosh: 'संतोष', sachin: 'सचिन', sunil: 'सुनील', anil: 'अनिल', vijay: 'विजय', sanjay: 'संजय',
    ajay: 'अजय', ashok: 'अशोक', prakash: 'प्रकाश', vikas: 'विकास', dnyaneshwar: 'ज्ञानेश्वर', dyaneshwar: 'ज्ञानेश्वर',
    vitthal: 'विठ्ठल', pandurang: 'पांडुरंग', tukaram: 'तुकाराम', dattatray: 'दत्तात्रय', dattatraya: 'दत्तात्रय',
    gangadhar: 'गंगाधर', shivaji: 'शिवाजी', sambhaji: 'संभाजी', shankar: 'शंकर', bhagwan: 'भगवान',
    laxman: 'लक्ष्मण', lakshman: 'लक्ष्मण', narayan: 'नारायण', maruti: 'मारुती', sopan: 'सोपान', kailas: 'कैलास',
    kailash: 'कैलास', nitin: 'नितीन', rahul: 'राहुल', amol: 'अमोल', sandip: 'संदीप', sandeep: 'संदीप',
    pradip: 'प्रदीप', pradeep: 'प्रदीप', dilip: 'दिलीप', ravi: 'रवी', raju: 'राजू', kisan: 'किसन', kishan: 'किसन',
    govind: 'गोविंद', keshav: 'केशव', madhav: 'माधव', uttam: 'उत्तम', arjun: 'अर्जुन', baban: 'बबन', bapu: 'बापू',
    appa: 'आप्पा', anna: 'अण्णा', nana: 'नाना', dada: 'दादा', bhau: 'भाऊ', balasaheb: 'बाळासाहेब',
    bhausaheb: 'भाऊसाहेब', annasaheb: 'अण्णासाहेब', babasaheb: 'बाबासाहेब', bhimrao: 'भीमराव', rajendra: 'राजेंद्र',
    mahadev: 'महादेव', bhaskar: 'भास्कर', raghunath: 'रघुनाथ', eknath: 'एकनाथ', kashinath: 'काशीनाथ', sahebrao: 'साहेबराव',
    // women
    pushpa: 'पुष्पा', sunita: 'सुनीता', anita: 'अनिता', savita: 'सविता', kavita: 'कविता', sangita: 'संगीता',
    sangeeta: 'संगीता', lata: 'लता', sita: 'सीता', gita: 'गीता', geeta: 'गीता', rekha: 'रेखा', usha: 'उषा',
    asha: 'आशा', mangal: 'मंगल', manisha: 'मनीषा', jyoti: 'ज्योती', lakshmi: 'लक्ष्मी', laxmi: 'लक्ष्मी',
    parvati: 'पार्वती', radha: 'राधा', kamal: 'कमल', shobha: 'शोभा', sharda: 'शारदा', sharada: 'शारदा',
    sarita: 'सरिता', suman: 'सुमन', chhaya: 'छाया', meera: 'मीरा', mira: 'मीरा', nirmala: 'निर्मला',
    ujwala: 'उज्ज्वला', sushila: 'सुशीला', shanta: 'शांता', kusum: 'कुसुम', sakhu: 'सखू', yamuna: 'यमुना',
    ganga: 'गंगा', godavari: 'गोदावरी', kanta: 'कांता', alka: 'अलका', vandana: 'वंदना', rukmini: 'रुक्मिणी',
    sindhu: 'सिंधू', indu: 'इंदू', anjana: 'अंजना', archana: 'अर्चना', swati: 'स्वाती',
    // Muslim names common in the area
    shaikh: 'शेख', sheikh: 'शेख', shekh: 'शेख', mohammad: 'मोहम्मद', mohammed: 'मोहम्मद', mohd: 'मोहम्मद',
    abdul: 'अब्दुल', ali: 'अली', khan: 'खान', pathan: 'पठाण', syed: 'सय्यद', sayyad: 'सय्यद', rafiq: 'रफिक',
    salim: 'सलीम', fatima: 'फातिमा', shabana: 'शबाना', rehana: 'रेहाना', ayub: 'अय्युब', yusuf: 'युसूफ',
    // surnames
    patil: 'पाटील', pawar: 'पवार', jadhav: 'जाधव', shinde: 'शिंदे', more: 'मोरे', kale: 'काळे',
    gaikwad: 'गायकवाड', gaywal: 'गायवळ', deshmukh: 'देशमुख', kulkarni: 'कुलकर्णी', deshpande: 'देशपांडे',
    joshi: 'जोशी', kadam: 'कदम', chavan: 'चव्हाण', salunke: 'साळुंके', bhosale: 'भोसले', mane: 'माने',
    sawant: 'सावंत', kamble: 'कांबळे', waghmare: 'वाघमारे', sonawane: 'सोनवणे', ghule: 'घुले', munde: 'मुंडे',
    kshirsagar: 'क्षीरसागर', solanke: 'सोळंके', dhas: 'धस', khade: 'खाडे', sanap: 'सानप', wagh: 'वाघ',
    kharat: 'खरात', gite: 'गिते', nagargoje: 'नागरगोजे', raut: 'राऊत', thorat: 'थोरात', gholap: 'घोलप',
    bangar: 'बांगर', jagtap: 'जगताप', dhakne: 'ढाकणे', kendre: 'केंद्रे', phad: 'फड', karad: 'कराड',
    shelke: 'शेळके', mhaske: 'म्हस्के', lokhande: 'लोखंडे', bhalerao: 'भालेराव', tayde: 'तायडे', wankhede: 'वानखेडे',
    // places
    beed: 'बीड', bid: 'बीड', nawabpur: 'नवाबपूर', pimpalner: 'पिंपळनेर', bordevi: 'बोरदेवी', maharashtra: 'महाराष्ट्र'
  };
  const SUFFIX = [['saheb', 'साहेब'], ['bai', 'बाई'], ['rao', 'राव'], ['nath', 'नाथ'], ['wadi', 'वाडी'],
    ['pur', 'पूर'], ['gaon', 'गाव']];

  const CONS = [['ksh', 'क्ष'], ['chh', 'छ'], ['dny', 'ज्ञ'], ['kh', 'ख'], ['gh', 'घ'], ['ch', 'च'], ['jh', 'झ'],
    ['th', 'थ'], ['dh', 'ध'], ['ph', 'फ'], ['bh', 'भ'], ['sh', 'श'], ['k', 'क'], ['g', 'ग'], ['c', 'क'], ['j', 'ज'],
    ['z', 'झ'], ['t', 'त'], ['d', 'द'], ['n', 'न'], ['p', 'प'], ['f', 'फ'], ['b', 'ब'], ['m', 'म'], ['y', 'य'],
    ['r', 'र'], ['l', 'ल'], ['v', 'व'], ['w', 'व'], ['s', 'स'], ['h', 'ह'], ['q', 'क'], ['x', 'क्स']];
  // [latin, independent, matra]
  const VOW = [['aa', 'आ', 'ा'], ['ai', 'ऐ', 'ै'], ['au', 'औ', 'ौ'], ['ee', 'ई', 'ी'], ['oo', 'ऊ', 'ू'],
    ['a', 'अ', ''], ['i', 'इ', 'ि'], ['u', 'उ', 'ु'], ['e', 'ए', 'े'], ['o', 'ओ', 'ो']];

  function phonetic(w) {
    const toks = [];
    for (let i = 0; i < w.length;) {
      const c = CONS.find(([l]) => w.startsWith(l, i));
      if (c) { toks.push({ t: 'c', l: c[0], d: c[1] }); i += c[0].length; continue; }
      const v = VOW.find(([l]) => w.startsWith(l, i));
      if (v) { toks.push({ t: 'v', l: v[0], ind: v[1], m: v[2] }); i += v[0].length; continue; }
      i++; // skip unknown
    }
    let s = '';
    toks.forEach((k, i) => {
      const prev = toks[i - 1], next = toks[i + 1], last = i === toks.length - 1;
      if (k.t === 'c') {
        // n/m between a vowel and a consonant → anusvara (गंगा, संजय)
        if ((k.l === 'n' || k.l === 'm') && prev && prev.t === 'v' && next && next.t === 'c' && next.l !== 'y' && next.l !== 'h') { s += 'ं'; return; }
        s += k.d;
        if (next && next.t === 'c') s += '्';
      } else {
        if (!prev || prev.t === 'v') { s += k.ind; return; }
        if (last && k.l === 'a') s += 'ा';        // final -a → ा (पुष्पा, गंगा)
        else if (last && k.l === 'i') s += 'ी';   // final -i → ी (लक्ष्मी)
        else if (last && k.l === 'u') s += 'ू';   // final -u → ू (राजू)
        else s += k.m;
      }
    });
    return s;
  }

  function word2mr(w) {
    const lw = w.toLowerCase().replace(/[^a-z]/g, '');
    if (!lw) return w;
    if (DICT[lw]) return DICT[lw];
    for (const [suf, mr] of SUFFIX) {
      if (lw.endsWith(suf) && lw.length > suf.length + 2) {
        const stem = lw.slice(0, -suf.length);
        return (DICT[stem] || phonetic(stem)) + mr;
      }
    }
    return phonetic(lw);
  }
  const toMarathi = text => (text || '').split(/\s+/).filter(w => /[a-z]/i.test(w)).map(word2mr).join(' ');

  // ---------- main ----------
  async function read(file, onProgress = () => {}) {
    onProgress(0.01);
    await loadLibs();
    const canvases = await renderPages(file);
    onProgress(0.05);
    const pages = await ocrPages(canvases, onProgress);
    const f = readFields(pages[0]);
    if (!f['Farmer Name']) throw Object.assign(new Error('not-krishika'), { code: 'not-krishika' });
    const allText = pages.map(p => p.text).join('\n');
    const lands = readLands(pages.slice(1).map(p => p.text).join('\n'));
    const { crops, season } = readCrops(allText);
    const rel = (f['Relative Type'] || '').toUpperCase().replace(/[^A-Z]/g, '');
    const village = (f['Village'] || '').replace(/\(.*\)/, '').trim();
    const aad = (f['Aadhar Number'] || '').match(/(\d{4})\s*$/);

    onProgress(1);
    return {
      raw: f,
      nameEn: f['Farmer Name'],
      name: toMarathi(f['Farmer Name']),
      relNameEn: f['Relative Name'] || '',
      relName: toMarathi(f['Relative Name']),
      gender: /female/i.test(f['Gender'] || '') ? 'f' : (/male/i.test(f['Gender'] || '') ? 'm' : ''),
      relation: rel === 'WO' ? '2' : rel === 'DO' ? '1' : rel === 'SO' ? '0' : '',
      occupation: /agri/i.test(f['Primary Occupation'] || '') ? 'शेती' : '',
      district: toMarathi(f['District']),
      taluka: toMarathi(f['Block/Subdistrict']),
      villageEn: village,
      village: toMarathi(village),
      landVillageEn: (lands[0] && lands[0].village) || village,
      landVillage: toMarathi((lands[0] && lands[0].village) || village),
      aadhaarLast4: aad ? aad[1] : '',
      lands, crops, season
    };
  }

  window.Krishika = { read, toMarathi };
})();
