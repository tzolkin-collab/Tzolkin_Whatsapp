const https = require('https');

https.get('https://en.wikipedia.org/wiki/Claude_(language_model)', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const match = data.match(/src="([^"]+Claude_AI_symbol\.svg[^"]*)"/);
    if (match) {
      const url = match[1].startsWith('//') ? 'https:' + match[1] : match[1];
      console.log('Found URL:', url);
      // Fetch the actual SVG
      let svgUrl = url;
      // Wikipedia serves scaled PNGs sometimes, let's get the original SVG URL
      // Upload path looks like: upload.wikimedia.org/wikipedia/commons/4/47/Claude_AI_symbol.svg
      const svgMatch = data.match(/href="([^"]+upload\.wikimedia\.org\/wikipedia\/commons\/[^"]+\/Claude_AI_symbol\.svg)"/);
      if (svgMatch) {
        svgUrl = svgMatch[1].startsWith('//') ? 'https:' + svgMatch[1] : svgMatch[1];
      } else {
         // reconstruct from thumb url if it's a thumb
         // //upload.wikimedia.org/wikipedia/commons/thumb/x/xx/Claude_AI_symbol.svg/200px-Claude_AI_symbol.svg.png
         const parts = url.split('/');
         const idx = parts.indexOf('thumb');
         if (idx !== -1) {
            parts.splice(idx, 1); // remove 'thumb'
            parts.pop(); // remove '200px-...'
            svgUrl = 'https:' + parts.join('/');
         }
      }
      console.log('SVG URL:', svgUrl);
      https.get(svgUrl, (svgRes) => {
        let svgData = '';
        svgRes.on('data', chunk => svgData += chunk);
        svgRes.on('end', () => console.log(svgData));
      });
    } else {
      console.log('Not found');
    }
  });
});
