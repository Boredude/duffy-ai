import { describe, expect, it } from 'vitest';
import {
  buildBrandBoardPrompt,
  buildBrandBoardPromptWithRefs,
  selectBrandBoardReferences,
} from '../../src/services/onboarding/brandBoardImage.js';
import type { Brand } from '../../src/db/schema.js';

function makeBrand(overrides: Partial<Brand> = {}): Brand {
  const base: Brand = {
    id: 'brand-1',
    igHandle: 'ob.cocktails',
    websiteUrl: 'https://obcocktails.com/',
    awaitingWebsiteReply: false,
    voiceJson: {
      summary: 'Minimal celebratory cocktail brand.',
      tone: ['minimal', 'celebratory', 'poetic'],
      audience: 'Israeli corporate clients and event planners.',
      do: ['Lead with the drink', 'Lean into elegance'],
      dont: ['Use slang', 'Use stock photos'],
    },
    cadenceJson: null,
    brandKitJson: {
      palette: [
        { hex: '#c9579a', role: 'primary', name: 'vibrant pink' },
        { hex: '#d873ab', role: 'secondary', name: 'medium pink' },
      ],
      typography: {
        mood: 'Brand type system from the live site: Lexend Deca for headings, Inter for body.',
        source: 'website',
        headingFont: 'Lexend Deca',
        bodyFont: 'Inter',
        fontFamilies: ['Lexend Deca', 'Inter'],
      },
      logo: {
        markType: 'combo',
        description:
          "Monogram of 'O' and 'B' on a vibrant pink square, with 'OB COCKTAILS' wordmark beneath.",
        colors: ['#c9579a', '#ffffff'],
        hasTagline: false,
        profilePicUrl: 'https://r2.example/profile.jpg',
      },
    },
    designSystemJson: {
      photoStyle: 'Soft-focus lifestyle photography with dreamy bokeh.',
      illustrationStyle: 'Delicate line illustrations with floral motifs.',
      composition: 'Intimate close-ups with single-subject focus.',
      lighting: 'Soft diffused natural light.',
      recurringMotifs: ['coupe glasses', 'pink florals'],
      doVisuals: ['Soft pinks', 'Floral garnish'],
      dontVisuals: ['Hard fluorescent light'],
    },
    igAnalysisJson: {
      capturedAt: '2026-04-30T07:23:51.000Z',
      handle: 'ob.cocktails',
      profile: {
        profilePicUrl: 'https://r2.example/profile.jpg',
      },
      posts: [
        { url: 'https://www.instagram.com/p/p1/', imageUrl: 'https://r2.example/p1.jpg', caption: '', likes: 21 },
        { url: 'https://www.instagram.com/p/p2/', imageUrl: 'https://r2.example/p2.jpg', caption: '', likes: 11 },
        { url: 'https://www.instagram.com/p/p3/', imageUrl: 'https://r2.example/p3.jpg', caption: '', likes: 5 },
      ],
    },
    conversationLanguageSample: null,
    brandBoardImageUrl: null,
    timezone: 'Asia/Jerusalem',
    status: 'onboarding',
    createdAt: new Date('2026-04-30T07:00:00Z'),
    updatedAt: new Date('2026-04-30T07:30:00Z'),
  };
  return { ...base, ...overrides };
}

describe('buildBrandBoardPromptWithRefs', () => {
  it('anchors the corner mark on reference 1 and posts on references 2..N when profile pic is present', () => {
    const brand = makeBrand();
    const prompt = buildBrandBoardPromptWithRefs(brand, { hasProfilePic: true, postCount: 2 });
    expect(prompt).toContain('You will receive 3 reference images.');
    expect(prompt).toContain('Reference 1 is the brand');
    expect(prompt).toContain('References 2-3 are representative posts');
    expect(prompt).toContain("brand's actual mark — taken from reference 1");
    expect(prompt).toContain('reference 1 is a portrait/photo with no logo');
    expect(prompt).toContain('reference photos');
  });

  it('renders the corner mark from text description when only post refs are available', () => {
    const brand = makeBrand();
    const prompt = buildBrandBoardPromptWithRefs(brand, { hasProfilePic: false, postCount: 2 });
    expect(prompt).toContain('You will receive 2 reference images.');
    expect(prompt).not.toContain('Reference 1 is the brand');
    expect(prompt).toContain('References 1-2 are representative posts');
    // The text-described mark fallback note is present and references no
    // image reference id (it's pure descriptive text in the corner).
    expect(prompt).toContain('Render this as descriptive text');
    expect(prompt).toContain('combo —');
    // Closing aesthetic line should NOT promise the corner mark came from
    // any reference because the profile-pic ref is missing.
    expect(prompt).not.toContain('taken from reference');
  });

  it('handles a profile-pic-only layout without referring to non-existent post refs', () => {
    const brand = makeBrand();
    const prompt = buildBrandBoardPromptWithRefs(brand, { hasProfilePic: true, postCount: 0 });
    expect(prompt).toContain('You will receive 1 reference image.');
    expect(prompt).toContain('Reference 1 is the brand');
    expect(prompt).not.toContain('representative post');
    expect(prompt).not.toContain('Visual style strip');
    expect(prompt).not.toContain('reference photos');
  });

  it('produces a website-typography section that does not contradict the chosen fonts', () => {
    const brand = makeBrand();
    const prompt = buildBrandBoardPromptWithRefs(brand, { hasProfilePic: true, postCount: 2 });
    expect(prompt).toContain('Render the title in Lexend Deca');
    expect(prompt).toContain('Use Inter for the descriptive line');
    // The historical legacy fallback wording must not leak into the
    // website-source path.
    expect(prompt).not.toContain('typographic style described as');
    // And — the safety net — must not encourage script substitutes for
    // clean sans-serif fonts.
    expect(prompt).toContain('do NOT substitute with a script');
  });

  it('keeps the legacy mood-led typography section when source is instagram', () => {
    const brand = makeBrand({
      brandKitJson: {
        ...(makeBrand().brandKitJson as NonNullable<Brand['brandKitJson']>),
        typography: {
          mood: 'A grounded, classic serif paired with quiet captions.',
          source: 'instagram',
        },
      },
    });
    const prompt = buildBrandBoardPromptWithRefs(brand, { hasProfilePic: true, postCount: 2 });
    expect(prompt).toContain('typographic style described as "A grounded, classic serif');
    expect(prompt).not.toContain('Render the title in Lexend Deca');
  });
});

describe('buildBrandBoardPrompt (text-only fallback)', () => {
  it('still emits the historical "Logo / mark note" fallback line', () => {
    const brand = makeBrand();
    const prompt = buildBrandBoardPrompt(brand);
    expect(prompt).toContain('Logo / mark note (small text in a corner):');
    expect(prompt).toContain('combo —');
  });
});

describe('selectBrandBoardReferences', () => {
  it('returns top-2 posts by engagement and the persisted profile-pic URL', () => {
    const brand = makeBrand();
    const refs = selectBrandBoardReferences(brand);
    expect(refs.profilePicUrl).toBe('https://r2.example/profile.jpg');
    // Posts are sorted by likes+comments desc, top 2 only.
    expect(refs.postUrls).toEqual(['https://r2.example/p1.jpg', 'https://r2.example/p2.jpg']);
  });

  it('returns null profile pic when none persisted (logo + igAnalysis both empty)', () => {
    const brand = makeBrand({
      brandKitJson: { ...(makeBrand().brandKitJson as NonNullable<Brand['brandKitJson']>), logo: undefined },
      igAnalysisJson: {
        ...(makeBrand().igAnalysisJson as NonNullable<Brand['igAnalysisJson']>),
        profile: {},
      },
    });
    const refs = selectBrandBoardReferences(brand);
    expect(refs.profilePicUrl).toBeNull();
  });
});
