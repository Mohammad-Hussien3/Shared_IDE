import { useEffect, useState } from "react";
import "./App.css";

function App() {
    const [workspaces, setWorkspaces] = useState([]);

    const API_URL = import.meta.env.VITE_API_URL;

    useEffect(() => {
        console.log("Django API:", API_URL);

        fetch(`${API_URL}/workspaces/`)
            .then((response) => response.json())
            .then((data) => {
                console.log("Django response:", data);
                setWorkspaces(data);
            })
            .catch((error) => {
                console.error("API error:", error);
            });
    }, []);

    return (
        <div>
            <h1>Web IDE</h1>

            <h2>Workspaces</h2>

            <pre>
                {JSON.stringify(workspaces, null, 2)}
            </pre>
        </div>
    );
}

export default App;