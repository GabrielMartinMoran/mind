@web @product/neural-map
Feature: Neural Map Graph View

  The neural map shows a space's memories as a deterministic tier-ring graph with an accessible table mirror.

  Background:
    Given the web application is loaded
    And a space "test" exists with memories

  Rule: Graph API integration

    @integration
    Scenario: Graph API call fetches nodes and edges
      When navigating to the neural map view
      Then the graph API is called for the current space with limit 1000
      And all available nodes are rendered
      And nodes and edges are rendered

    @integration
    Scenario: Graph loading shows a skeleton
      When the graph data is loading
      Then a skeleton is displayed
      And the graph region is aria-busy

  Rule: Pan and zoom interaction

    @integration
    Scenario: Pan with direct manipulation follows the pointer
      Given the neural map is displayed
      When the user drags on the canvas
      Then the graph transform changes in the drag direction
      And the memory panel does not open

    @integration
    Scenario: Zoom with the mouse wheel
      Given the neural map is displayed
      When the user scrolls the mouse wheel over the map
      Then the graph zooms in or out

    @integration
    Scenario: Zoom buttons work
      Given the neural map is displayed
      When clicking the zoom in button
      Then the graph zooms in
      And clicking zoom out zooms out

    @integration
    Scenario: Zoom has minimum and maximum limits
      Given the neural map is at a zoom limit
      When the user keeps zooming
      Then the zoom level stays within 0.45–4.5

  Rule: Node interaction

    @integration
    Scenario: Node click opens the memory panel
      Given the neural map is displayed
      When clicking on a memory node
      Then the memory panel opens
      And the URL includes the memory param
      And no extra graph request is made

    @integration
    Scenario: Node keyboard activation opens the memory panel
      Given a graph node has focus
      When pressing Enter
      Then the memory panel opens

    @integration
    Scenario: Arrow keys move between nodes
      Given a graph node has focus
      When pressing an arrow key
      Then focus moves to the nearest node in that direction
      And Home and End move to the first and last node

  Rule: Accessible graph

    @integration
    Scenario: Graph is a group, not an image
      When the neural map renders
      Then the SVG has role group with an aria-label
      And nodes are exposed as buttons with roving tabindex
      And the SVG does not have role img

    @integration
    Scenario: Accessible table mirrors the graph
      When the neural map renders
      Then a "Memory list" table lists every rendered node
      And each row links to the memory

    @integration
    Scenario: Focus returns after closing the panel
      Given a node opened the memory panel
      When the panel closes
      Then focus returns to the same node

  Rule: Selection highlight

    @integration
    Scenario: Selected node highlights incoming and outgoing links
      Given a node with two incoming and one outgoing links
      When the node is selected
      Then all three incident edges are highlighted
      And unrelated edges are muted
      And directly connected nodes are emphasized

    @integration
    Scenario: Dense cap does not hide selected links
      Given a low-degree node whose links fall outside the 200-edge context cap
      When the node is selected
      Then its incident edges are added to the DOM
      And they are removed on deselect

    @integration
    Scenario: Dense maps show no persistent labels
      Given a dense map
      Then no name labels are shown by default

    @integration
    Scenario: Hover, focus and selection show one label
      Given a dense map
      When the user hovers, focuses or selects a node
      Then exactly one transient name label is shown
      And it is 11.5–13px on screen
      And it uses a contrasting halo
      And dense labels truncate at 24 characters with the full name in the title

    @integration
    Scenario: Small maps show all labels
      Given a map with 80 or fewer nodes
      Then every node name label is visible

    @integration
    Scenario: Tier boundaries have equal spacing
      Given a map with T1, T2 and T3 nodes
      Then the T1→T2 gap equals the T2→T3 gap

  Rule: Degree encoding

    @integration
    Scenario: Node radius encodes combined links
      Given nodes with 0, 4 and 62 links
      When the map renders
      Then the radius increases with degree
      And the radius is capped for high-degree nodes

    @integration
    Scenario: Link count is rendered inside the node
      Given a node with 12 links
      When the node renders
      Then the number "12" is centered inside the circle
      And the node aria-label includes "12 links"
      And the number is aria-hidden

    @integration
    Scenario: Degree font fits the circle
      Given a node with a two-digit degree
      When the node renders
      Then the degree text does not overflow the circle

  Rule: Tier rings and labels

    @integration
    Scenario: Three concentric rings exist for T1, T2 and T3
      When the neural map renders
      Then three tier rings are present
      And each tier has a label and a text token

    @integration
    Scenario: Labels are truncated to 25 characters
      Given a memory with a very long name
      When the label renders
      Then the visible label is truncated with an ellipsis
      And the full name is available to assistive technology

    @integration
    Scenario: Tier color is paired with text
      Given a node in tier 2
      When the node renders
      Then its accessible name includes "Tier T2"
      And color is not the only tier signal
