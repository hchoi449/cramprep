## Local Development (Cloudflare Pages Functions)

This project serves calendar events from a Pages Function at `/api/events`.

### Authentication (MongoDB Atlas Data API)

Signup/Login is implemented via Cloudflare Pages Functions:

- `functions/api/auth/signup.ts` — POST email/password to create user
- `functions/api/auth/login.ts` — POST email/password to login
- `functions/api/auth/me.ts` — GET current session from cookie

Passwords are hashed using PBKDF2-SHA256. A JWT is set as an HttpOnly cookie `tbp_session` (7 days).

Required Cloudflare Pages environment variables:

- `MONGODB_DATA_API_URL` (e.g., https://data.mongodb-api.com/app/<app-id>/endpoint/data/v1/action)
- `MONGODB_DATA_API_KEY`
- `MONGODB_DATA_SOURCE` (e.g., Cluster0)
- `MONGODB_DATABASE` (e.g., thinkbigprep)
- `MONGODB_COLLECTION_USERS` (e.g., users)
- `JWT_SECRET` (strong random string)

Enable Atlas Data API for your project/app in MongoDB Atlas.

### Alternate Auth via Render (MongoDB URI)

If Atlas Data API is unavailable, deploy a small API on Render using the MongoDB driver:

- Directory: `render-api/`
- Endpoints:
  - `POST /auth/signup` — { fullName, email, password }
  - `POST /auth/login` — { email, password }
  - `GET /auth/me` — with `Authorization: Bearer <jwt>`
- Env vars on Render:
  - `MONGODB_URI` (your SRV)
  - `MONGODB_DATABASE` (e.g., thinkbigprep)
  - `MONGODB_COLLECTION_USERS` (users)
  - `JWT_SECRET` (strong random)

Set `window.TBP_AUTH_BASE = 'https://<your-render-service>.onrender.com'` on pages to direct login/signup to Render API.

### Seed Data
- File: `data/events.json`
- Shape:
  - Subject: `"Algebra II" | "Geometry" | "Calculus" | "Chemistry" | "Physics" | "Biology"`
  - CalendarEvent fields: `id, title, school, tutorName, subject, start, end, meetLink?, comments?, createdBy`.

To add events, edit `data/events.json` and push. Pages deploy will serve the new data.

### Run locally
1. Install Wrangler if needed: `npm i -g wrangler`
2. From the project root, run:
   ```bash
   wrangler dev
   ```
3. Open the local URL; the timetable page will fetch `/api/events`.
4. For auth endpoints locally with wrangler, define vars in a `.dev.vars` file:
   ```
   MONGODB_DATA_API_URL=...
   MONGODB_DATA_API_KEY=...
   MONGODB_DATA_SOURCE=...
   MONGODB_DATABASE=...
   MONGODB_COLLECTION_USERS=users
   JWT_SECRET=replace-with-strong-secret
   ```

Notes:
- Response headers: `Content-Type: application/json`, `Cache-Control: private, max-age=0`.
- Errors return 5xx with `{ "error": "message" }`.
# AMC Academy Website Replica

A modern, responsive website replica of [AMC Academy](https://www.amcacademy.org/) built with HTML, CSS, and JavaScript. This project showcases a professional math tutoring academy website with all the key features and functionality of the original site.

## 🎯 Features

### Design & Layout
- **Modern, Professional Design**: Clean and elegant design that matches the original AMC Academy aesthetic
- **Fully Responsive**: Optimized for desktop, tablet, and mobile devices
- **Smooth Animations**: CSS animations and transitions for enhanced user experience
- **Interactive Elements**: Hover effects, smooth scrolling, and dynamic interactions

### Sections Included
1. **Hero Section**: Eye-catching landing area with call-to-action buttons
2. **Assessment Process**: Three-step process explanation with icons
3. **Elite Coaches**: Showcase of USAMO medalists and university mathematicians
4. **Learning Platform**: Features of the proprietary web application
5. **Course Offerings**: Three-tier pricing structure (AMC 10, AMC 12, AIME)
6. **Success Stories**: Student testimonials and success cases
7. **Contact Information**: Multiple ways to get in touch

### Technical Features
- **Mobile-First Design**: Responsive navigation with mobile menu
- **Smooth Scrolling**: Navigation links smoothly scroll to sections
- **Interactive Cards**: Coach and course cards with hover effects
- **Modern Typography**: Inter font family for better readability
- **CSS Custom Properties**: Consistent color scheme and styling
- **Performance Optimized**: Efficient CSS and JavaScript

## 🚀 Getting Started

### Prerequisites
- A modern web browser
- Basic knowledge of HTML, CSS, and JavaScript (for customization)

### Installation
1. Clone or download this repository
2. Open `index.html` in your web browser
3. The website should load immediately with all functionality

### Development Setup
If you want to modify the project:

1. **Install Dependencies** (if using npm):
   ```bash
   npm install
   ```

2. **Run Tailwind Build** (for CSS processing):
   ```bash
   npm run start:tailwind
   ```

3. **Build for Production**:
   ```bash
   npm run build:tailwind
   ```

## 📁 Project Structure

```
cramprep-1/
├── assets/
│   ├── images/
│   │   ├── brand-logos/     # University logos
│   │   ├── home/           # Dashboard and sample images
│   │   └── people/         # Coach profile images
│   └── logo/               # AMC Academy logo
├── css/
│   ├── index.css          # Custom styles
│   ├── tailwind-build.css # Production CSS
│   └── tailwind.css       # Tailwind source
├── index.html             # Main HTML file
├── index.js              # JavaScript functionality
├── package.json          # Project dependencies
├── tailwind.config.js    # Tailwind configuration
└── readme.md             # This file
```

## 🎨 Customization

### Colors
The color scheme is defined in CSS custom properties in `css/index.css`:
```css
:root {
    --primary-color: #2563eb;
    --primary-dark: #1d4ed8;
    --secondary-color: #10b981;
    --accent-color: #8b5cf6;
    --text-primary: #1f2937;
    --text-secondary: #6b7280;
    --bg-light: #f9fafb;
    --bg-white: #ffffff;
    --border-color: #e5e7eb;
}
```

### Content
- Update coach information in the coaches section
- Modify course pricing and features
- Add or remove testimonials
- Update contact information

### Styling
- Modify `css/index.css` for custom styles
- Update Tailwind classes in HTML for layout changes
- Add new animations in the CSS file

## 📱 Responsive Breakpoints

- **Mobile**: < 640px
- **Tablet**: 640px - 1024px
- **Desktop**: > 1024px

## 🔧 Technologies Used

- **HTML5**: Semantic markup
- **CSS3**: Modern styling with custom properties
- **JavaScript**: Interactive functionality
- **Tailwind CSS**: Utility-first CSS framework
- **Bootstrap Icons**: Icon library
- **Inter Font**: Modern typography

## 🌟 Key Features Implemented

### Navigation
- Fixed header with smooth scroll effects
- Mobile-responsive hamburger menu
- Active link highlighting

### Animations
- Fade-in animations on scroll
- Hover effects on cards and buttons
- Smooth transitions throughout

### Interactive Elements
- Course scheduling buttons
- Contact form links
- Social media integration ready

### Performance
- Optimized images and assets
- Efficient CSS and JavaScript
- Fast loading times
