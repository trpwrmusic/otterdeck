import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './panel.css';
import './chat/chat.css';

createRoot(document.getElementById('root')!).render(<App />);
