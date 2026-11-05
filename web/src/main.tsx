import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './panel.css';
import './pages.css';
import './chat/chat.css';
import './responsive.css';

createRoot(document.getElementById('root')!).render(<App />);
