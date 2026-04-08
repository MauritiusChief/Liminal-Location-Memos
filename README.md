# Liminal Location Memos

Minimal full-stack template with a React + Redux + TypeScript frontend and a Node.js + TypeScript backend.

## Structure

- `frontend/`: Vite + React + Redux Toolkit client
- `backend/`: Express API server with OpenAI-compatible LLM proxy

## Requirements

- Node.js 24+

## Setup

1. Install frontend dependencies:
   - `cd frontend`
   - `npm install`
2. Install backend dependencies:
   - `cd backend`
   - `npm install`
3. Create `backend/.env` from `backend/.env.example`

## Backend environment variables

- `PORT`: backend port, default `3001`
- `LLM_API_KEY`: API key for the LLM provider
- `LLM_BASE_URL`: OpenAI-compatible base URL, such as `https://api.openai.com`
- `LLM_MODEL`: model name passed to the chat completions endpoint

## Run

Start backend:

```powershell
cd backend
npm run dev
```

Start frontend in another terminal:

```powershell
cd frontend
npm run dev
```

The frontend proxies `/api` requests to `http://localhost:3001`.

