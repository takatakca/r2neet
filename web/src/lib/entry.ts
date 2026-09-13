import { boot } from './main.js';

boot().catch((error: unknown) => {
  console.error('[r2nette] boot failed', error);
});

// Load the hero photograph independently from the booking API.
const photo = document.getElementById('heroPhoto');

if (photo) {
  const image = new Image();

  image.onload = () => {
    photo.classList.add('loaded');
  };

  image.onerror = () => {
    console.warn('[r2nette] hero image could not be loaded');
  };

  image.src = '/assets/hero.jpg';
}