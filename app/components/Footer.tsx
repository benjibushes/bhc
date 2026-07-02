'use client';

import Container from './Container';
import Divider from './Divider';
import Button from './Button';

export default function Footer() {
  return (
    <footer className="py-12">
      <Container>
        <div className="text-center space-y-6">
          <div className="flex flex-wrap justify-center gap-4 text-sm">
            <Button href="/map" variant="secondary">Map</Button>
            <Button href="/wins" variant="secondary">Wins</Button>
            <Button href="/founders" variant="secondary">Founders</Button>
            <Button href="/brand-partners" variant="secondary">Brand Partners</Button>
            <Button href="/sell" variant="secondary">Sell Your Beef</Button>
            <Button href="/map/add-a-rancher" variant="secondary">Add a Rancher</Button>
            <Button href="/apply" variant="secondary">Apply as a rancher</Button>
            <Button href="/faq" variant="secondary">FAQ</Button>
            <Button href="/support" variant="secondary">Support</Button>
            <Button href="/about" variant="secondary">About</Button>
            <Button href="/news" variant="secondary">News</Button>
            <Button href="https://merch.buyhalfcow.com/collections/hats?utm_source=buyhalfcow&utm_medium=footer&utm_campaign=hat-launch" variant="secondary" external>Hats</Button>
            <Button href="/member/login" variant="secondary">Member Login</Button>
            <Button href="/rancher/login" variant="secondary">Rancher Login</Button>
          </div>

          <Divider />

          <div className="flex flex-wrap justify-center gap-6 text-xs text-dust">
            <a href="/terms" className="hover:text-charcoal transition-colors">Terms</a>
            <a href="/privacy" className="hover:text-charcoal transition-colors">Privacy</a>
          </div>

          <div className="space-y-2 text-sm text-dust">
            <p>BuyHalfCow is a private, approval-only network for sourcing ranch beef direct.</p>
            <p>Kalispell, MT &middot; <a href="https://instagram.com/buyhalfcow" target="_blank" rel="noopener noreferrer" className="hover:text-charcoal transition-colors">@buyhalfcow</a></p>
          </div>
        </div>
      </Container>
    </footer>
  );
}
