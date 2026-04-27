import './App.css'

function App() {
  return (
    <main className="app" data-testid="app-root">
      <div className="card">
        <h1 className="title" data-testid="hello-heading">
          Hello World
        </h1>
        <p className="subtitle" data-testid="hello-subtitle">
          Welcome to your React + Vite + TypeScript app
        </p>
      </div>
    </main>
  )
}

export default App
