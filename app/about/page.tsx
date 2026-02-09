import Container from '../components/Container';
import Divider from '../components/Divider';
import Button from '../components/Button';

export const metadata = {
  title: 'About — BuyHalfCow',
  description: 'Learn about BuyHalfCow\'s mission to connect serious buyers with verified ranchers',
};

export default function AboutPage() {
  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="max-w-3xl mx-auto space-y-12">
          <div className="text-center space-y-6">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
              About BuyHalfCow
            </h1>
            <Divider />
            <p className="text-xl leading-relaxed text-[#6B4F3F]">
              A private network built on trust, transparency, and real relationships.
            </p>
          </div>

          <div className="space-y-8 leading-relaxed text-lg">
            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-3xl">
                Why We Exist
              </h2>
              <p>
                BuyHalfCow was created to solve a simple problem: connecting people who care about 
                where their beef comes from with ranchers who do it the right way.
              </p>
              <p>
                We're not trying to disrupt anything. We're not building algorithms. We're not 
                creating a marketplace. We're simply making introductions.
              </p>
              <p className="font-medium">
                This is ranching as it should be — personal, transparent, and built on trust.
              </p>
            </section>

            <Divider />

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-3xl">
                What We Do
              </h2>
              <p>
                We manually review every ranch, every deal, and every partnership to maintain quality.
              </p>
              <div className="grid md:grid-cols-3 gap-6 my-8">
                <div className="p-6 border border-[#A7A29A]">
                  <h3 className="font-[family-name:var(--font-serif)] text-xl mb-2">Certify Ranchers</h3>
                  <p className="text-base">We verify operations, practices, and capacity before listing.</p>
                </div>
                <div className="p-6 border border-[#A7A29A]">
                  <h3 className="font-[family-name:var(--font-serif)] text-xl mb-2">Approve Members</h3>
                  <p className="text-base">Serious buyers only. We keep the community small and intentional.</p>
                </div>
                <div className="p-6 border border-[#A7A29A]">
                  <h3 className="font-[family-name:var(--font-serif)] text-xl mb-2">Curate Deals</h3>
                  <p className="text-base">Land opportunities and brand partnerships vetted for quality.</p>
                </div>
              </div>
            </section>

            <Divider />

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-3xl">
                What We're Not
              </h2>
              <ul className="space-y-3">
                <li className="flex items-start">
                  <span className="mr-3 text-[#8C2F2F]">✗</span>
                  <span>Not a marketplace with checkout buttons</span>
                </li>
                <li className="flex items-start">
                  <span className="mr-3 text-[#8C2F2F]">✗</span>
                  <span>Not an algorithm matching you with ranchers</span>
                </li>
                <li className="flex items-start">
                  <span className="mr-3 text-[#8C2F2F]">✗</span>
                  <span>Not trying to scale fast and break things</span>
                </li>
                <li className="flex items-start">
                  <span className="mr-3 text-[#8C2F2F]">✗</span>
                  <span>Not open to everyone (that's the point)</span>
                </li>
              </ul>
            </section>

            <Divider />

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-3xl">
                How It Works
              </h2>
              <div className="space-y-6">
                <div>
                  <h3 className="font-medium mb-2">For Buyers:</h3>
                  <ol className="list-decimal list-inside space-y-2 ml-4">
                    <li>Apply for access</li>
                    <li>Get approved (we review manually)</li>
                    <li>See certified ranchers in your state</li>
                    <li>Connect directly, no middleman</li>
                  </ol>
                </div>
                <div>
                  <h3 className="font-medium mb-2">For Ranchers:</h3>
                  <ol className="list-decimal list-inside space-y-2 ml-4">
                    <li>Apply with ranch details</li>
                    <li>Get verified and certified</li>
                    <li>Connect with serious buyers in your state</li>
                    <li>10% commission on facilitated sales</li>
                  </ol>
                </div>
              </div>
            </section>

            <Divider />

            <section className="space-y-4">
              <h2 className="font-[family-name:var(--font-serif)] text-3xl">
                Our Values
              </h2>
              <div className="space-y-3">
                <p><strong>Trust First:</strong> Every decision is made with trust in mind.</p>
                <p><strong>Quality Over Scale:</strong> We'd rather stay small and good than big and mediocre.</p>
                <p><strong>Real Relationships:</strong> No algorithms, no automation — just people.</p>
                <p><strong>Transparency:</strong> You know exactly who you're buying from and where your beef comes from.</p>
              </div>
            </section>

            <Divider />

            <div className="text-center space-y-6">
              <p className="text-xl">
                Ready to join the network?
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button href="/access">Apply for Access</Button>
                <Button href="/partner" variant="secondary">Become a Partner</Button>
              </div>
            </div>
          </div>
        </div>
      </Container>
    </main>
  );
}


