# Data Structures and Casing

Semantic data structures and consistent casing conventions eliminate entire
categories of bugs. This reference provides detailed transformation patterns
and boundary adaptation examples.

## Transformation Examples

### Address Value Object — replacing Primitive Obsession

Group related primitives that always travel together into a semantic type.

**Before (Primitive Obsession):**

```python
# Three functions that all take the same three primitives
def calculate_shipping(street: str, city: str, zip_code: str) -> float:
    if city == "New York":
        return 15.0
    return 10.0

def format_address_label(street: str, city: str, zip_code: str) -> str:
    return f"{street}, {city} {zip_code}"

def validate_address(street: str, city: str, zip_code: str) -> bool:
    return len(street) > 0 and len(city) > 0 and len(zip_code) == 5
```

**After (Address value object):**

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class Address:
    street: str
    city: str
    zip_code: str

    def is_in_city(self, name: str) -> bool:
        return self.city == name

    def format_label(self) -> str:
        return f"{self.street}, {self.city} {self.zip_code}"

    def is_valid(self) -> bool:
        return len(self.street) > 0 and len(self.city) > 0 and len(self.zip_code) == 5

def calculate_shipping(address: Address) -> float:
    if address.is_in_city("New York"):
        return 15.0
    return 10.0
```

**TypeScript equivalent:**

```typescript
interface Address {
  street: string;
  city: string;
  zipCode: string;
}

function calculateShipping(address: Address): number {
  return address.city === "New York" ? 15.0 : 10.0;
}

function formatAddressLabel(address: Address): string {
  return `${address.street}, ${address.city} ${address.zipCode}`;
}

function isValidAddress(address: Address): boolean {
  return address.street.length > 0
    && address.city.length > 0
    && address.zipCode.length === 5;
}
```

### Nested Configuration — replacing flat, disconnected data

Flat key-value pairs obscure structure and make validation repetitive.

**Before (flat configuration):**

```python
# Flat — every key is disconnected from related keys
config = {
    "database_host": "localhost",
    "database_port": 5432,
    "database_name": "myapp",
    "database_user": "admin",
    "database_password": "secret",
    "redis_host": "localhost",
    "redis_port": 6379,
    "redis_db": 0,
    "redis_password": "",
    "api_host": "0.0.0.0",
    "api_port": 8080,
    "api_debug": True,
    "api_cors_origins": ["http://localhost:3000"],
}
```

**After (nested configuration):**

```python
from dataclasses import dataclass, field

@dataclass
class DatabaseConfig:
    host: str = "localhost"
    port: int = 5432
    name: str = "myapp"
    user: str = "admin"
    password: str = "secret"

@dataclass
class RedisConfig:
    host: str = "localhost"
    port: int = 6379
    db: int = 0
    password: str = ""

@dataclass
class ApiConfig:
    host: str = "0.0.0.0"
    port: int = 8080
    debug: bool = False
    cors_origins: list[str] = field(default_factory=list)

@dataclass
class AppConfig:
    database: DatabaseConfig = field(default_factory=DatabaseConfig)
    redis: RedisConfig = field(default_factory=RedisConfig)
    api: ApiConfig = field(default_factory=ApiConfig)

# Usage: one config object, clear structure
app_config = load_config("config.yaml", AppConfig)
app_config.database.host  # self-documenting
```

**TypeScript equivalent:**

```typescript
interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

interface RedisConfig {
  host: string;
  port: number;
  db: number;
  password: string;
}

interface ApiConfig {
  host: string;
  port: number;
  debug: boolean;
  corsOrigins: string[];
}

interface AppConfig {
  database: DatabaseConfig;
  redis: RedisConfig;
  api: ApiConfig;
}

// Usage
const config: AppConfig = loadConfig("config.yaml");
config.database.host;
```

### Parallel Arrays to Typed Objects

Parallel arrays are a code smell: they couple unrelated data by index position,
are fragile under reordering, and make refactoring dangerous.

**Before (parallel arrays — fragile by index):**

```python
# Three arrays coupled by index position
user_names = ["Alice", "Bob", "Charlie"]
user_ages = [30, 25, 35]
user_emails = ["alice@example.com", "bob@example.com", "charlie@example.com"]

# Adding a new field means adding a fourth array — fragile and error-prone
user_roles = ["admin", "user", "user"]

def get_user_info(index: int) -> str:
    return f"{user_names[index]} ({user_ages[index]}) — {user_emails[index]}"

# Filtering requires parallel index tracking
def get_adult_users() -> list[str]:
    result = []
    for i in range(len(user_names)):
        if user_ages[i] >= 18:
            result.append(user_names[i])
    return result
```

**After (typed objects — one data structure):**

```python
from dataclasses import dataclass

@dataclass
class User:
    name: str
    age: int
    email: str
    role: str = "user"

    def summary(self) -> str:
        return f"{self.name} ({self.age}) — {self.email}"

    def is_adult(self) -> bool:
        return self.age >= 18

users = [
    User(name="Alice", age=30, email="alice@example.com", role="admin"),
    User(name="Bob", age=25, email="bob@example.com"),
    User(name="Charlie", age=35, email="charlie@example.com"),
]

# Adding a new field: add it to the User class. No index coordination needed.
adult_users = [user for user in users if user.is_adult()]
```

**TypeScript equivalent:**

```typescript
interface User {
  name: string;
  age: number;
  email: string;
  role?: string;
}

const users: User[] = [
  { name: "Alice", age: 30, email: "alice@example.com", role: "admin" },
  { name: "Bob", age: 25, email: "bob@example.com" },
  { name: "Charlie", age: 35, email: "charlie@example.com" },
];

const adultUsers = users.filter((user) => user.age >= 18);
```

### Boundary Casing Adaptation — snake_case API to camelCase Internal

Foreign casing must be converted at the point of ingress. Anything downstream
works in the project's native casing.

**Scenario:** A REST API returns `snake_case` JSON. The internal TypeScript
codebase uses `camelCase`. Adapt at the boundary once.

**Before (foreign casing leakage):**

```typescript
// API response leaks snake_case into every internal consumer
interface ApiArticle {
  article_id: string;
  author_name: string;
  published_at: string;
  is_featured: boolean;
  thumbnail_url: string | null;
  view_count: number;
  tags: { tag_name: string; tag_slug: string }[];
}

// Every internal function now works in snake_case — the leak spreads
function renderArticleCard(article: ApiArticle): string {
  const date = new Date(article.published_at);
  return `<h2>${article.article_id}</h2>
          <cite>${article.author_name}</cite>
          <time>${date.toLocaleDateString()}</time>`;
}

function filterFeatured(articles: ApiArticle[]): ApiArticle[] {
  return articles.filter((a) => a.is_featured && a.view_count > 100);
}
```

**After (adapt at the boundary):**

```typescript
// Internal model — camelCase throughout the codebase
interface Article {
  articleId: string;
  authorName: string;
  publishedAt: Date;
  isFeatured: boolean;
  thumbnailUrl: string | null;
  viewCount: number;
  tags: { tagName: string; tagSlug: string }[];
}

// Boundary adapter — convert once, at the API response handler
function mapArticleFromApi(raw: any): Article {
  return {
    articleId: raw.article_id,
    authorName: raw.author_name,
    publishedAt: new Date(raw.published_at),
    isFeatured: raw.is_featured,
    thumbnailUrl: raw.thumbnail_url ?? null,
    viewCount: raw.view_count,
    tags: raw.tags?.map((t: any) => ({
      tagName: t.tag_name,
      tagSlug: t.tag_slug,
    })) ?? [],
  };
}

// Every internal function works in native camelCase
function renderArticleCard(article: Article): string {
  return `<h2>${article.articleId}</h2>
          <cite>${article.authorName}</cite>
          <time>${article.publishedAt.toLocaleDateString()}</time>`;
}

function filterFeatured(articles: Article[]): Article[] {
  return articles.filter((a) => a.isFeatured && a.viewCount > 100);
}

// Usage: adapt at fetch boundary
async function getFeaturedArticles(): Promise<Article[]> {
  const response = await fetch("/api/articles");
  const json = await response.json();
  return json.data.map(mapArticleFromApi); // converted once, here
}
```

## Casing Adaptation Patterns

| Ingress Source | Typical Casing | Internal Target | Adapt At |
| -------------- | -------------- | --------------- | -------- |
| REST API (JSON) | `snake_case` or `camelCase` | Language convention | Response deserializer |
| GraphQL | `camelCase` by convention | Language convention | Response deserializer |
| PostgreSQL | `snake_case` (column names) | Language convention | Row mapper / ORM |
| MySQL | `snake_case` (column names) | Language convention | Row mapper / ORM |
| MongoDB | `camelCase` by convention | Language convention | Document mapper |
| CSV / file import | Varies by source | Language convention | Parser / importer |
| gRPC / Protobuf | `snake_case` (field names) | Language convention | Generated code (auto-adapts if configured) |

**Rule:** The adapter function sits at exactly one point — the module that
receives the external data. No other module imports or references the
foreign casing.

## Detection Checklist

Use these questions during code review to identify data structure and casing
problems:

- Are the same 2-3 primitives repeated across multiple function signatures?
  → Group into a value object.
- Is a configuration represented as a flat dictionary or map with no nesting?
  → Nest related keys under named sections.
- Are multiple arrays coupled by index position?
  → Merge into a single array of typed objects.
- Does a database row or API response type appear in business logic files?
  → Create an adapter at the boundary, use internal types everywhere else.
- Do you see `snake_case` and `camelCase` in the same module?
  → Pick one for the language. If the other comes from external data, adapt
    it at the boundary.

