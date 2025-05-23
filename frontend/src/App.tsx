import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Main from './page/Main';
import Stream from './page/Stream';
import Watch from './page/Watch';

function App() {
  return (
    <div className="App">
      <Router>
        <Routes>
          <Route path="/" element={<Main />} />
          <Route path="/stream" element={<Stream />} />
          <Route path="/watch" element={<Watch />} />
          <Route path="*" element={<Main />} />
        </Routes>
      </Router>
    </div>
  );
}

export default App;
