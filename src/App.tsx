import { useEffect, useRef, useState } from 'react'
import './App.css'

function App() {
  const aboutRef = useRef<HTMLElement | null>(null)
  const [aboutVisible, setAboutVisible] = useState(false)

  useEffect(() => {
    const node = aboutRef.current
    if (!node) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setAboutVisible(true)
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.2 },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <main className="app" data-testid="app-root">
      <section className="hero" data-testid="hero-section">
        <div className="card">
          <h1 className="title" data-testid="hello-heading">
            Hello World
          </h1>
          <p className="subtitle" data-testid="hello-subtitle">
            Welcome to your React + Vite + TypeScript app
          </p>
        </div>

        <div className="scroll-hint" aria-hidden="true">
          <span className="scroll-hint__label">Scroll</span>
          <span className="scroll-hint__chevron" />
        </div>
      </section>

      <section
        ref={aboutRef}
        className={`about${aboutVisible ? ' about--visible' : ''}`}
        data-testid="about-section"
        aria-labelledby="about-name"
      >
        <div className="about__container">
          <img
            className="about__photo"
            src="https://im.runware.ai/image/os/w01d10/ws/2/ii/f284fed0-e233-46b1-8cba-41d98767fe49.webp"
            alt="Portrait of Jane Doe"
            width={150}
            height={150}
            data-ai-id="profile-photo"
            data-testid="profile-photo"
            loading="lazy"
          />
          <h2 className="about__name" id="about-name" data-testid="about-name">
            Jane Doe
          </h2>
          <p className="about__role" data-testid="about-role">
            Full-Stack Developer &amp; Creative Thinker
          </p>
          <p className="about__bio" data-testid="about-bio">
            I'm passionate about building things that blend thoughtful design
            with solid engineering. From quick prototypes to production-grade
            systems, I love turning ideas into experiences people actually
            enjoy using. When I'm not shipping code, you'll find me sketching
            new concepts or chasing the next interesting problem.
          </p>
        </div>
      </section>
    </main>
  )
}

export default App
