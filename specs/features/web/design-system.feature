@web @product/design-system
Feature: Web Design System

  The web uses one token system for color, type, spacing, focus and motion.

  Background:
    Given the web application is loaded

  Rule: Color and contrast

    @contract
    Scenario: Text tokens meet WCAG AA
      Then body text has a contrast ratio of at least 4.5:1
      And secondary and metadata text have a contrast ratio of at least 4.5:1

    @contract
    Scenario: UI boundaries meet non-text contrast
      Then input, button and card boundaries have a contrast ratio of at least 3:1
      And the focus ring has a contrast ratio of at least 3:1

    @integration
    Scenario: Tier color is not the only signal
      Given a memory in tier 1
      When its tier badge renders
      Then the badge shows "T1"
      And the color is paired with text

    @integration
    Scenario: Confidence is not color-only
      Given a search result with high confidence
      Then the result shows a "High confidence" label
      And the color is paired with text

  Rule: Typography

    @contract
    Scenario: Metadata is legible
      Then metadata text is at least 12px
      And body text is at least 14px
      And line length is at most 72 characters

  Rule: Interaction states

    @integration
    Scenario: Focus is always visible
      Given a keyboard user tabs to an interactive element
      Then a 2px accent focus ring is visible
      And no interactive element removes the focus indicator

    @integration
    Scenario: Cards are links
      Given a memory card renders
      Then the card is an anchor element
      And the anchor has an href
      And the card contains no nested button or second link

  Rule: Action icon system

    @contract
    Scenario: Command buttons use one local icon style
      Given an action button renders
      Then it uses one decorative icon from the local icon sprite
      And the icon uses currentColor and the shared stroke style
      And the icon is hidden from assistive technology
      And the action keeps its visible text label

    @contract
    Scenario: Icon artwork is self-hosted
      Given an action icon is rendered
      Then its artwork comes from the local SVG sprite
      And the web app does not require a CDN or runtime icon package
      And the applicable icon license notices are retained

    @integration
    Scenario: Search result tags remain passive data
      Given a search result has descriptive tags
      Then each tag is a passive data chip, not a button or link
      And each tag is outside the result's single anchor
      And the chips do not add keyboard stops

    @integration
    Scenario: Search result links keep their label beside a decorative icon
      Given a search result card renders
      Then the card remains one anchor with a descriptive accessible name
      And its open affordance uses a decorative local icon

    @integration
    Scenario: State selectors do not get command icons
      Given the tier chips or a filter select renders
      Then the control communicates its state with its existing label and state
      And it has no extra command icon

    @integration
    Scenario: Icon-only mobile actions retain an accessible name
      Given a topbar or space action is compact at a narrow viewport
      Then its text remains available to assistive technology
      And its button has a descriptive accessible name

  Rule: Graph context

    @integration
    Scenario: Memory panel keeps graph context visible
      Given the memory panel is open over the neural map
      Then the backdrop is a light scrim
      And the highlighted graph remains visible behind the dialog

  Rule: Motion

    @integration
    Scenario: Motion is limited to state changes
      Then there are no ambient pulse, glow or breathing animations
      And transitions only run when the interface state changes

    @integration
    Scenario: Reduced motion removes transitions
      Given prefers-reduced-motion is reduce
      When a panel, drawer or toast opens
      Then it appears without animation

  Rule: Responsive layout

    @integration
    Scenario: No horizontal scroll at 320px
      Given the viewport is 320px wide
      When viewing home, search, space and map
      Then the page has no horizontal scroll

    @manual
    Scenario: 200% zoom reflows without clipping
      Given the browser is at 200% zoom
      When viewing home, search, space and map
      Then content reflows without horizontal scrolling
      And no primary action is clipped
