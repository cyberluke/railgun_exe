const fs = require('fs');
const lines = fs.readFileSync('.github/workflows/ci.yml','utf8').split(/\r?\n/).filter((l,i)=>l.trim() && !(l.trim().startsWith('#') && !l.trim().includes(':')));
function parse(n, ind) {}
let pos = 0;
function parseBlock(minIndent) {
  // array vs map based on first meaningful line
  const first = lines[pos];
  const i0 = first.search(/\S/);
  if (i0 < minIndent) return null;
  if (first.trim().startsWith('- ')) {
    const arr = [];
    while (pos < lines.length) {
      const L = lines[pos]; const ind = L.search(/\S/);
      if (ind < minIndent) break;
      if (ind === minIndent && L.trim().startsWith('- ')) {
        const rest = L.trim().slice(2);
        pos++;
        if (rest.includes(':')) { arr.push(parseInline(minIndent + 2, rest)); }
        else arr.push(rest);
      } else if (ind > minIndent) {
        // continuation of last seq item map
        const sub = parseBlock(minIndent + 2);
        Object.assign(arr[arr.length-1] ||= {}, sub);
      } else break;
    }
    return arr;
  }
  const map = {};
  while (pos < lines.length) {
    const L = lines[pos]; const ind = L.search(/\S/);
    if (ind < minIndent) break;
    if (ind === minIndent) {
      const m = /^(.+?):(?: (.*))?$/.exec(L.trim());
      if (!m) { console.log('BAD line', pos+1, L); return null; }
      let k=m[1], v=m[2];
      if (v !== undefined && v !== '') { map[k] = v; pos++; }
      else { pos++;
        if (v === '' && pos < lines.length && lines[pos].search(/\S/) > minIndent) map[k] = parseBlock(lines[pos].search(/\S/));
        else if (v === '') map[k] = null;
      }
    } else { console.log('DESYNC at', pos+1, JSON.stringify(L)); return null; }
  }
  return map;
}
function parseInline(indent, firstRest) {
  // build a map from lines starting with "key: val" pairs, firstRest already read
  const map = {}; let rest = firstRest;
  function addPair(s){ const m=/^(.+?):(?: (.*))?$/.exec(s.trim()); if(m){ if(m[2]) map[m[1]]=m[2]; else { const ni=pos<lines.length?lines[pos].search(/\S/):0; map[m[1]] = ni>indent-2 ? parseBlock(ni) : null; } } }
  addPair(rest);
  while (pos < lines.length) {
    const L=lines[pos]; const ind=L.search(/\S/);
    if (ind < indent-2+2 || (ind===indent && L.trim().startsWith('- '))) break;
    if (ind >= indent) { addPair(L); pos++; } else break;
  }
  return map;
}
const out = parseBlock(0);
console.log('top:', Object.keys(out), 'jobs:', Object.keys(out.jobs), 'on:', JSON.stringify(out.on));
