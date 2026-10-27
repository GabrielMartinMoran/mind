@web @product/modals
Feature: Modals

  Accessible dialogs for creating and editing spaces and memories.

  Background:
    Given the web application is loaded

  Rule: Dialog behavior

    @integration
    Scenario: Open a modal
      When the user activates "New space"
      Then a dialog opens with the form
      And focus moves to the first field

    @integration
    Scenario: Focus is trapped in the modal
      Given a modal is open
      When the user tabs through the dialog
      Then focus stays inside the dialog

    @integration
    Scenario: Escape closes the modal
      Given a modal is open
      When the user presses Escape
      Then the modal closes
      And focus returns to the trigger

    @integration
    Scenario: Modal can be reopened after Escape
      Given a modal was closed with Escape
      When the user opens it again
      Then the modal is visible and usable

    @integration
    Scenario: Backdrop click closes the modal
      Given a modal is open
      When the user clicks the backdrop
      Then the modal closes

  Rule: New space

    @integration
    Scenario: Create a space
      Given the new space modal is open
      When the user enters a name and description
      And submits
      Then the space is created
      And the modal closes

    @integration
    Scenario: Cancel does not create a space
      Given the new space modal is open
      When the user cancels
      Then no space is created

  Rule: New memory

    @integration
    Scenario: Create a memory
      Given the new memory modal is open
      When the user enters a name, content, tags and tier
      And submits
      Then the memory is created
      And the modal closes

    @integration
    Scenario: Cancel does not create a memory
      Given the new memory modal is open
      When the user cancels
      Then no memory is created

    @integration
    Scenario: New memory returns focus to its contextual trigger
      Given the New memory action is beside the open space title
      When the user opens and cancels the new memory modal
      Then focus returns to the New memory action

  Rule: Delete confirmation

    @integration
    Scenario: Confirm deletion
      Given a memory exists
      When the user confirms deletion
      Then the memory is deleted

    @integration
    Scenario: Cancel deletion keeps the memory
      Given the delete confirmation is shown
      When the user cancels
      Then the memory is preserved

  Rule: Validation and errors

    @integration
    Scenario: Required name is enforced
      Given the form is open
      When the user submits an empty name
      Then an inline error is shown
      And the dialog stays open

    @integration
    Scenario: API error is shown without losing input
      Given the form is open
      When the request fails
      Then an error is shown in the dialog
      And the entered values remain

  Rule: Styling

    @integration
    Scenario: Modal surface is solid, not glass
      When a modal is open
      Then the surface uses the design tokens
      And there is no backdrop-filter or glow

    @integration
    Scenario: Focus ring is visible
      Given a modal is open
      When a field receives focus
      Then a 2px accent focus ring is visible

    @integration
    Scenario: Reduced motion opens instantly
      Given prefers-reduced-motion is reduce
      When a modal opens or closes
      Then no animation plays

  Rule: Command actions

    @integration
    Scenario: Dialog command actions keep labels beside decorative icons
      Given a create, edit or delete dialog is open
      Then each command button keeps its visible text label
      And its local icon is decorative and hidden from assistive technology
      And any icon-only control has a descriptive accessible name
