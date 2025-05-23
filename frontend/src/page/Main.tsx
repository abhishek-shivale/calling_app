import { useNavigate } from "react-router-dom";

function Main() {
const navigate = useNavigate();

  return (
    <div id="menu">
      <button onClick={() => navigate("/stream")}> Stream </button>
      <button onClick={() => navigate("/watch")}> Watch </button>
    </div>
  );
}

export default Main;
