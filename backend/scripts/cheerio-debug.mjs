import * as cheerio from 'cheerio';
import fs from 'node:fs';
const html = fs.readFileSync('/Users/adithyagiri/Desktop/Regrader/backend/data/gs-inspect/cs170-course.html', 'utf8');
const $ = cheerio.load(html);
console.log('html len:', html.length);
console.log('table.dataTable count:', $('table.dataTable').length);
console.log('table.dataTable tr count:', $('table.dataTable tr').length);
console.log('table.dataTable tbody count:', $('table.dataTable tbody').length);
console.log('table.dataTable tbody tr count:', $('table.dataTable tbody tr').length);
console.log('all tr count:', $('tr').length);
console.log('all a /submissions/ count:', $('a[href*="/submissions/"]').length);
$('table.dataTable tbody tr').slice(0,3).each((i, r) => {
  const c = $(r).children().length;
  const t = $(r).text().trim().slice(0,80);
  const a = $(r).find('a[href*="/submissions/"]').length;
  console.log('row ' + i + ': cells=' + c + ' aSub=' + a + ' text=' + t);
});
