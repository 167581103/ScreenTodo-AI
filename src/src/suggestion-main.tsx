import { createRoot } from 'react-dom/client';
import SuggestionApp from './SuggestionApp';
import './suggestion.css';

createRoot(document.getElementById('suggestion-root')!).render(<SuggestionApp />);
