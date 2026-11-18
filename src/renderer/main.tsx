import '@fontsource-variable/inter';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installSelfTest } from './selftest';

createRoot(document.getElementById('root')!).render(<App />);

if (location.hash === '#selftest') installSelfTest();
