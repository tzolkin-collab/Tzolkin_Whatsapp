const https = require('https');
const fs = require('fs');
const path = require('path');

const logos = [
  {
    name: 'pix-logo.svg',
    url: 'https://cdn.simpleicons.org/pix/32BCA4'
  },
  {
    name: 'visa-logo.svg',
    url: 'https://cdn.simpleicons.org/visa/white'
  },
  {
    name: 'mastercard-logo.svg',
    url: 'https://cdn.simpleicons.org/mastercard'
  }
];

function downloadLogo(logo) {
  const destPath = path.join(__dirname, 'public', 'images', 'svgs', logo.name);
  
  https.get(logo.url, (res) => {
    if (res.statusCode !== 200) {
      console.error(`Failed to download ${logo.name}: HTTP ${res.statusCode}`);
      return;
    }
    
    const fileStream = fs.createWriteStream(destPath);
    res.pipe(fileStream);
    
    fileStream.on('finish', () => {
      fileStream.close();
      console.log(`Successfully downloaded ${logo.name}`);
    });
  }).on('error', (err) => {
    console.error(`Error downloading ${logo.name}:`, err.message);
  });
}

logos.forEach(downloadLogo);
