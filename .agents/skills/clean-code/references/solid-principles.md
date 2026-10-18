# SOLID Principles

Single Responsibility, Open/Closed, Liskov Substitution, Interface
Segregation, and Dependency Inversion — five principles that guide class
design toward systems that are easier to maintain, test, and extend.

## SRP — Single Responsibility Principle

> A class should have exactly one reason to change.

When a class handles business rules, persistence, validation, and reporting,
a change to any of those concerns forces recompilation and retesting of the
entire class. Split responsibilities into separate, focused classes so each
changes for one reason only.

**Detection question:** "Is this class doing more than one thing? Could I
describe its responsibilities with the word 'and'?"

**Python example:**

```python
# Violation: one class handles persistence AND business rules
class UserService:
    def create_user(self, data: dict) -> User:
        self.validate(data)                   # validation
        user = User(name=data["name"])        # business rule
        db.session.add(user)                  # persistence
        db.session.commit()
        email_service.send_welcome(user.email) # notification
        return user

# Compliance: split into focused classes
class UserCreator:
    def create(self, data: dict) -> User:
        self.validator.validate(data)
        return User(name=data["name"])

class UserRepository:
    def save(self, user: User) -> None:
        db.session.add(user)
        db.session.commit()
```

**TypeScript example:**

```typescript
// Violation: component handles API, state, and rendering logic
// Compliance: extract API calls to a service, state to a store

class OrderService {
  async placeOrder(items: Item[]): Promise<Order> {
    const total = this.calculateTotal(items); // business rule
    const order = await this.api.create({ items, total }); // API call
    await this.notifier.send(`Order ${order.id} placed`); // notification
    return order;
  }
}
// Fix: split into OrderCalculator, OrderApiClient, OrderNotifier
```

## OCP — Open/Closed Principle

> Classes should be open for extension but closed for modification.

Add new behavior by writing new code, not by editing existing working code.
Editing a class that already works risks introducing bugs in paths that were
previously correct. Use polymorphism, the strategy pattern, or plugin
architectures to make behavior extensible without changing tested code.

**Detection question:** "To add a new variant of this behavior, do I need to
edit an existing class or can I add a new one?"

**Python example:**

```python
# Violation: adding a new discount type requires editing calculate_discount
class DiscountCalculator:
    def calculate(self, order: Order, discount_type: str) -> float:
        if discount_type == "percentage":
            return order.total * 0.1
        elif discount_type == "fixed":
            return 10.0
        # To add "seasonal", must edit this function
        raise ValueError(f"Unknown type: {discount_type}")

# Compliance: each discount is a new class
class Discount(ABC):
    @abstractmethod
    def apply(self, order: Order) -> float: ...

class PercentageDiscount(Discount):
    def apply(self, order: Order) -> float:
        return order.total * 0.1

class FixedDiscount(Discount):
    def apply(self, order: Order) -> float:
        return 10.0

# New discounts are added as new classes — zero edits to existing code
class SeasonalDiscount(Discount):
    def apply(self, order: Order) -> float:
        return order.total * 0.15 if is_holiday_season() else 0.0
```

**TypeScript example:**

```typescript
interface PaymentProcessor {
  process(amount: number): Promise<PaymentResult>;
}

class StripeProcessor implements PaymentProcessor {
  /* ... */
}
class PayPalProcessor implements PaymentProcessor {
  /* ... */
}
// Adding Square support: create SquareProcessor, register it — no edits to existing classes
```

## LSP — Liskov Substitution Principle

> Subtypes must be substitutable for their base types without breaking the
> program's correctness.

A subclass should not weaken preconditions, strengthen postconditions, or
throw exceptions that the parent never throws. Callers who depend on the
parent type should never receive a surprise from a child type.

**Detection question:** "Can I pass any subclass to code that expects the
parent class without special-case handling?"

**Python example:**

```python
# Violation: Square changes the semantics of set_width
class Rectangle:
    def set_width(self, w: int) -> None:
        self.width = w
    def set_height(self, h: int) -> None:
        self.height = h

class Square(Rectangle):
    def set_width(self, w: int) -> None:
        self.width = w
        self.height = w  # Surprise! Setting width also sets height.
    def set_height(self, h: int) -> None:
        self.width = h
        self.height = h
# Code that expects set_width to leave height unchanged breaks with Square.

# Fix: don't inherit Square from Rectangle; use a shared Shape interface
```

**TypeScript example:**

```typescript
// Violation: ReadOnlyList throws on mutating methods
class ReadOnlyList<T> extends Array<T> {
  push(...items: T[]): number {
    throw new Error("Cannot modify read-only list");
  }
}
// Code that calls list.push() on any Array breaks when given ReadOnlyList.
// Fix: implement a separate ReadOnlyList that doesn't extend Array
```

## ISP — Interface Segregation Principle

> Clients should not depend on methods they don't use.

A fat interface forces implementing classes to provide no-op or
`NotImplementedError` stubs for methods they don't need. It also couples
callers to methods they never invoke — a change to an unrelated method forces
recompilation.

**Detection question:** "Do all implementors of this interface use every
method, or do some leave stubs?"

**Python example:**

```python
# Violation: fat interface
class Worker(Protocol):
    def work(self) -> None: ...
    def eat(self) -> None: ...
    def sleep(self) -> None: ...

class Robot:
    def work(self) -> None:
        print("Working")
    def eat(self) -> None:
        raise NotImplementedError  # Robot doesn't eat!
    def sleep(self) -> None:
        raise NotImplementedError  # Robot doesn't sleep!

# Compliance: split into focused interfaces
class Workable(Protocol):
    def work(self) -> None: ...

class Eatable(Protocol):
    def eat(self) -> None: ...

class Robot:
    def work(self) -> None:
        print("Working")
# Robot implements only Workable — no stub methods
```

**TypeScript example:**

```typescript
// Violation
interface CloudProvider {
  upload(path: string, data: Buffer): Promise<void>;
  download(path: string): Promise<Buffer>;
  listFiles(prefix: string): Promise<string[]>; // Not all providers support listing
}

// Compliance: split
interface CloudStorage { upload(...): ...; download(...): ...; }
interface CloudListing { listFiles(...): ...; }
```

## DIP — Dependency Inversion Principle

> Depend on abstractions, not concretions.

High-level policy (business rules) should not depend on low-level details
(database drivers, HTTP clients, file systems). Both should depend on
abstractions (interfaces or protocols). This lets you swap implementations
without touching business logic and makes the business rules testable in
isolation.

**Detection question:** "If I change the database, do I need to edit the
business logic?"

**Python example:**

```python
# Violation: business logic depends directly on a concrete database
class OrderService:
    def __init__(self) -> None:
        self.db = PostgresDatabase()  # concrete dependency

# Compliance: depend on an interface
class OrderRepository(Protocol):
    def save(self, order: Order) -> None: ...

class PostgresOrderRepository:
    def save(self, order: Order) -> None:
        # actual Postgres insert
        ...

class OrderService:
    def __init__(self, repo: OrderRepository) -> None:
        self.repo = repo  # depends on abstraction
```

**TypeScript example:**

```typescript
interface PaymentGateway {
  charge(amount: number, token: string): Promise<ChargeResult>;
}

class OrderProcessor {
  constructor(private gateway: PaymentGateway) {} // depends on abstraction
  async checkout(order: Order, token: string): Promise<void> {
    const result = await this.gateway.charge(order.total, token);
    // ...
  }
}
```
