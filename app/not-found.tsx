import Container from './components/Container';
import Divider from './components/Divider';
import Button from './components/Button';

export default function NotFound() {
  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E] flex items-center">
      <Container>
        <div className="max-w-2xl mx-auto text-center space-y-8">
          <h1 className="font-[family-name:var(--font-serif)] text-6xl md:text-8xl">
            404
          </h1>
          <Divider />
          <p className="text-2xl md:text-3xl text-[#6B4F3F]">
            Page Not Found
          </p>
          <p className="text-lg leading-relaxed">
            The page you're looking for doesn't exist or has been moved.
          </p>
          <div className="pt-8">
            <Button href="/">Back to Home</Button>
          </div>
        </div>
      </Container>
    </main>
  );
}


