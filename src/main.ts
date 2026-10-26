import { mount, tick } from 'svelte';
import './app.css';

const query = new URLSearchParams(location.search);
const { default: App } = await (query.get('mode') === 'ultra' ? import('./UltraApp.svelte')
  : query.has('demo') || query.has('preview') || query.has('render') ? import('./App.svelte') : import('./CampaignApp.svelte'));
mount(App, { target: document.getElementById('app')! });
void tick().then(() => document.getElementById('boot-loading')?.remove());
