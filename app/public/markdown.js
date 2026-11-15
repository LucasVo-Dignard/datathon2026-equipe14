'use strict';
// Minimal Markdown renderer for the assistant's answers.
// Safe by construction: it builds DOM nodes (createElement + textContent) and
// never parses HTML, so nothing in the text can inject markup or scripts.
// Supported: headings, paragraphs, line breaks, bullet and numbered lists
// (one nesting level), tables, block quotes, code blocks, horizontal rules,
// **bold**, *italic*, `code`, [links](https://...) and bare http(s) URLs.
// Source citations: [@Name](https://...) renders as a small clickable chip
// with the site's icon and the source name (no link when the URL isn't http(s)).

(() => {
  const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function link(text, href) {
    if (!SAFE_URL.test(href)) return document.createTextNode(text);
    const a = el('a', { href, target: '_blank', rel: 'noopener noreferrer' });
    a.textContent = text;
    return a;
  }

  // Site icons come from DuckDuckGo's icon service (no tracking cookies). When
  // an icon can't load, the chip shows the source's initial instead.
  const ICON_URL = (host) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
  // Icon of the site's main domain: app.bigdata.com -> bigdata.com, but keep
  // two-level suffixes such as example.co.uk or gc.ca.
  function iconHost(hostname) {
    const parts = hostname.toLowerCase().replace(/^www\./, '').split('.');
    const keep = parts.length > 2 && /^(co|com|gov|gc|ac|org|net)$/.test(parts[parts.length - 2]) ? 3 : 2;
    return parts.slice(-keep).join('.');
  }

  function sourceChip(name, href) {
    const safe = SAFE_URL.test(href);
    const chip = safe
      ? el('a', { class: 'cite', href, target: '_blank', rel: 'noopener noreferrer', title: `${name} – ${href}` })
      : el('span', { class: 'cite', title: name });
    const mark = el('span', { class: 'cite-mark', 'aria-hidden': 'true' });
    mark.textContent = (name.trim()[0] || '?').toUpperCase();
    if (safe) {
      // Not lazy: the image is loaded before it is attached, then swapped in.
      const img = el('img', { class: 'cite-icon', alt: '', width: '14', height: '14', referrerpolicy: 'no-referrer' });
      img.addEventListener('load', () => { if (img.naturalWidth > 1) mark.replaceWith(img); }, { once: true });
      img.src = ICON_URL(iconHost(new URL(href).hostname));
    }
    const label = el('span', { class: 'cite-name' });
    label.textContent = name.trim();
    chip.append(mark, label);
    return chip;
  }

  // Inline: `code`, **bold**, *italic* / _italic_, [text](url), bare URLs.
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*\n]*?\*)|(\b_[^_\s][^_\n]*?_\b)/g;

  function inline(text, parent) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const [tok] = m;
      if (m[1]) {
        const c = el('code'); c.textContent = tok.slice(1, -1); parent.append(c);
      } else if (m[2]) {
        const b = el('strong'); inline(tok.slice(2, -2), b); parent.append(b);
      } else if (m[3]) {
        const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (label.startsWith('@') && label.length > 1) parent.append(sourceChip(label.slice(1), href));
        else parent.append(link(label, href));
      } else if (m[4]) {
        parent.append(link(tok, tok));
      } else {
        const i = el('em'); inline(tok.slice(1, -1), i); parent.append(i);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  const RE = {
    fence: /^\s*```/,
    heading: /^(#{1,6})\s+(.*)$/,
    hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
    quote: /^\s*>\s?(.*)$/,
    ul: /^(\s*)[-*+]\s+(.*)$/,
    ol: /^(\s*)\d+[.)]\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  };

  const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function renderMarkdown(source) {
    const root = document.createDocumentFragment();
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      if (RE.fence.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !RE.fence.test(lines[i])) code.push(lines[i++]);
        i++; // closing fence
        const pre = el('pre'); const c = el('code'); c.textContent = code.join('\n');
        pre.append(c); root.append(pre);
        continue;
      }

      let m = line.match(RE.heading);
      if (m) {
        // Chat answers: map # .. ###### to h3 .. h6 so titles stay small.
        const h = el(`h${Math.min(6, m[1].length + 2)}`);
        inline(m[2].replace(/\s*#+\s*$/, ''), h); root.append(h);
        i++; continue;
      }

      if (RE.hr.test(line)) { root.append(el('hr')); i++; continue; }

      if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
        const table = el('table'); const thead = el('thead'); const tbody = el('tbody');
        const head = el('tr');
        for (const c of cells(line)) { const th = el('th'); inline(c, th); head.append(th); }
        thead.append(head);
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const tr = el('tr');
          for (const c of cells(lines[i])) { const td = el('td'); inline(c, td); tr.append(td); }
          tbody.append(tr); i++;
        }
        table.append(thead, tbody);
        const wrap = el('div', { class: 'md-table' }); wrap.append(table); root.append(wrap);
        continue;
      }

      if (RE.quote.test(line)) {
        const q = el('blockquote'); const parts = [];
        while (i < lines.length && RE.quote.test(lines[i])) parts.push(lines[i++].match(RE.quote)[1]);
        const p = el('p'); parts.forEach((t, k) => { if (k) p.append(el('br')); inline(t, p); });
        q.append(p); root.append(q);
        continue;
      }

      if (RE.ul.test(line) || RE.ol.test(line)) {
        const ordered = !RE.ul.test(line);
        const list = el(ordered ? 'ol' : 'ul');
        let item = null; let sub = null;
        while (i < lines.length && lines[i].trim()) {
          const mu = lines[i].match(RE.ul); const mo = lines[i].match(RE.ol);
          const mm = mu || mo;
          if (!mm) {
            // Continuation line of the current item.
            if (!item) break;
            item.append(' '); inline(lines[i].trim(), sub ? sub.lastChild : item); i++; continue;
          }
          if (mm[1].length >= 2 && item) {
            if (!sub) { sub = el(mo ? 'ol' : 'ul'); item.append(sub); }
            const li = el('li'); inline(mm[2], li); sub.append(li);
          } else {
            if ((mo && !ordered) || (mu && ordered)) break; // list type changed
            item = el('li'); sub = null; inline(mm[2], item); list.append(item);
          }
          i++;
        }
        root.append(list);
        continue;
      }

      // Paragraph: consecutive plain lines, line breaks kept.
      const p = el('p'); let first = true;
      while (i < lines.length && lines[i].trim()
        && !RE.fence.test(lines[i]) && !RE.heading.test(lines[i]) && !RE.hr.test(lines[i])
        && !RE.ul.test(lines[i]) && !RE.ol.test(lines[i]) && !RE.quote.test(lines[i])
        && !(lines[i].includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]))) {
        if (!first) p.append(el('br'));
        inline(lines[i].trim(), p); first = false; i++;
      }
      root.append(p);
    }
    return root;
  }

  window.renderMarkdown = renderMarkdown;
})();
