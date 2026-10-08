import React from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<React.StrictMode><Theme appearance="light" accentColor="jade" grayColor="sage" radius="large"><App /></Theme></React.StrictMode>);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(console.warn));
